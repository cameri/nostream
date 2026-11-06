//! `EventRepository` against LMDB: the seven event databases, the write paths the capture's
//! `INSERT`/`ON CONFLICT` statements define, and the filter evaluation `sql.rs` composes.
//!
//! A read never holds a transaction across an await: a query materialises its page of
//! `(created_at, event_id)` keys inside one blocking closure, and the stream that returns the
//! rows re-seeks its cursor per batch (see [`ValuesStream`] and [`ReconciliationStream`]).

use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::ops::Bound;
use std::pin::Pin;
use std::task::{Context, Poll};

use chrono::{DateTime, Utc};
use futures_core::Stream;
use heed::types::Bytes;
use heed::{Database, Env, RoTxn, RwTxn};
use nostream_core::{EventId, Filter, Kind, KindSelector, Pubkey};
use tokio::task::JoinHandle;

use super::encoding::{self, EventHeader};
use super::rows;
use super::{
    DEFAULT_FILTER_LIMIT, Databases, Gates, MAX_PAGE_KEYS, RETENTION_BATCH_SIZE,
    STREAM_BATCH_ITEMS, STREAM_BATCH_KEYS,
};
use crate::error::StorageError;
use crate::repositories::{
    EventPurgeCounts, EventRecord, EventRetentionOptions, ReconciliationItem,
};

/// The kind of the capture's `REQUEST_TO_VANISH`, which every retention whitelist keeps and
/// every soft delete of one pubkey's ids spares.
const REQUEST_TO_VANISH: i32 = 62;

// ---------------------------------------------------------------------------------------
// Write paths.
// ---------------------------------------------------------------------------------------

/// `create`/`create_many`: an id that is already stored writes nothing and counts nothing.
pub(crate) fn create(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    records: &[EventRecord],
    now: DateTime<Utc>,
) -> Result<u64, StorageError> {
    let mut affected = 0;
    for record in records {
        if databases
            .events
            .get(txn, record.event.id.as_bytes())?
            .is_some()
        {
            continue;
        }
        let stored = EventRecord {
            row_id: None,
            event: record.event.clone(),
            first_seen: Some(now),
            deleted_at: None,
            expires_at: record.expires_at,
            // `INSERT_COLUMNS` omits the deduplication column, so the capture stores NULL.
            event_deduplication: None,
            remote_address: record.remote_address,
        };
        write_event(txn, databases, &stored)?;
        affected += 1;
    }
    Ok(affected)
}

/// `upsert`: a replaceable event merges through its pointer, and a stored id is a duplicate.
pub(crate) fn upsert(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    record: &EventRecord,
    now: DateTime<Utc>,
) -> Result<u64, StorageError> {
    Ok(u64::from(upsert_one(txn, databases, record, now)?))
}

/// `upsert_many`: the same merge, row by row, in one write transaction.
pub(crate) fn upsert_many(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    records: &[EventRecord],
    now: DateTime<Utc>,
) -> Result<u64, StorageError> {
    let mut affected = 0;
    for record in records {
        if upsert_one(txn, databases, record, now)? {
            affected += 1;
        }
    }
    Ok(affected)
}

fn upsert_one(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    record: &EventRecord,
    now: DateTime<Utc>,
) -> Result<bool, StorageError> {
    if databases
        .events
        .get(txn, record.event.id.as_bytes())?
        .is_some()
    {
        return Err(StorageError::DuplicateEvent);
    }

    let kind = kind_of(record)?;
    let deduplication = record.deduplication();
    let mut first_seen = None;

    if encoding::replaceable_kind(kind) {
        let pointer = encoding::replaceable_key(&record.event.pubkey, kind, &deduplication)?;
        if let Some(stored) = databases.replaceable.get(txn, &pointer)? {
            let stored_id = encoding::event_id_from(stored)?;
            let Some(value) = databases.events.get(txn, stored_id.as_bytes())? else {
                // A pointer with no row: treat the incoming event as a plain insert.
                return write_upserted(txn, databases, record, now, kind, &deduplication, None);
            };
            let stored_header = rows::event_header(value)?;
            let incoming_wins = stored_header.created_at < record.event.created_at
                || (stored_header.created_at == record.event.created_at
                    && stored_id > record.event.id);
            if !incoming_wins {
                return Ok(false);
            }
            let stored_record = rows::decode_event(value)?;
            first_seen = stored_record.first_seen;
            hard_delete(txn, databases, &stored_record)?;
            databases.replaceable.delete(txn, &pointer)?;
        }
    }

    write_upserted(
        txn,
        databases,
        record,
        now,
        kind,
        &deduplication,
        first_seen,
    )
}

fn write_upserted(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    record: &EventRecord,
    now: DateTime<Utc>,
    kind: i32,
    deduplication: &[serde_json::Value],
    first_seen: Option<DateTime<Utc>>,
) -> Result<bool, StorageError> {
    let stored = EventRecord {
        row_id: None,
        event: record.event.clone(),
        // `DO UPDATE` never writes `first_seen`, so a merged row keeps the one it had.
        first_seen: Some(first_seen.unwrap_or(now)),
        // The capture's merge list clears `deleted_at`.
        deleted_at: None,
        expires_at: record.expires_at,
        event_deduplication: Some(deduplication.to_vec()),
        remote_address: record.remote_address,
    };
    write_event(txn, databases, &stored)?;
    if encoding::replaceable_kind(kind) {
        databases.replaceable.put(
            txn,
            &encoding::replaceable_key(&record.event.pubkey, kind, deduplication)?,
            record.event.id.as_bytes(),
        )?;
    }
    Ok(true)
}

/// Writes an event and every index entry it needs.
fn write_event(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    record: &EventRecord,
) -> Result<(), StorageError> {
    let kind = kind_of(record)?;
    let id = record.event.id;
    let created_at = record.event.created_at;

    put_value(txn, databases, record)?;
    databases
        .events_by_created_at
        .put(txn, &encoding::created_at_key(created_at, &id), &[])?;
    databases.events_by_author.put(
        txn,
        &encoding::author_key(&record.event.pubkey, kind, created_at, &id),
        &[],
    )?;
    for (name, value) in encoding::tag_entries(record) {
        databases
            .tags
            .put(txn, &encoding::tag_key(name, value, created_at, &id)?, &[])?;
    }
    if let Some(expires_at) = record.expires_at {
        databases
            .events_expiring
            .put(txn, &encoding::time_key(expires_at, &id), &[])?;
    }
    Ok(())
}

/// Writes only the `events` value, which is what a soft delete changes.
fn put_value(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    record: &EventRecord,
) -> Result<(), StorageError> {
    let value = rows::encode_event(record)?;
    databases
        .events
        .put(txn, record.event.id.as_bytes(), &value)?;
    Ok(())
}

/// Removes an event from every database, which is what a replacement and a retention pass do.
fn hard_delete(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    record: &EventRecord,
) -> Result<(), StorageError> {
    let kind = kind_of(record)?;
    let id = record.event.id;
    let created_at = record.event.created_at;

    databases.events.delete(txn, id.as_bytes())?;
    databases
        .events_by_created_at
        .delete(txn, &encoding::created_at_key(created_at, &id))?;
    databases.events_by_author.delete(
        txn,
        &encoding::author_key(&record.event.pubkey, kind, created_at, &id),
    )?;
    if let Some(deleted_at) = record.deleted_at {
        databases
            .events_deleted
            .delete(txn, &encoding::time_key(deleted_at.timestamp(), &id))?;
    }
    if let Some(expires_at) = record.expires_at {
        databases
            .events_expiring
            .delete(txn, &encoding::time_key(expires_at, &id))?;
    }
    for (name, value) in encoding::tag_entries(record) {
        databases
            .tags
            .delete(txn, &encoding::tag_key(name, value, created_at, &id)?)?;
    }
    if let Some(deduplication) = &record.event_deduplication
        && encoding::replaceable_kind(kind)
    {
        let pointer = encoding::replaceable_key(&record.event.pubkey, kind, deduplication)?;
        if let Some(stored) = databases.replaceable.get(txn, &pointer)?
            && stored == &id.as_bytes()[..]
        {
            databases.replaceable.delete(txn, &pointer)?;
        }
    }
    Ok(())
}

/// Marks one event soft-deleted: the header bit, the JSON field and the deleted index. Every
/// read index is left alone, which is what keeps the row reachable by `find_by_filters`.
fn soft_delete(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    record: &EventRecord,
    now: DateTime<Utc>,
) -> Result<(), StorageError> {
    let mut record = record.clone();
    record.deleted_at = Some(now);
    put_value(txn, databases, &record)?;
    databases.events_deleted.put(
        txn,
        &encoding::time_key(now.timestamp(), &record.event.id),
        &[],
    )?;
    Ok(())
}

/// `delete_by_pubkey_and_ids`: a soft delete that never touches kind 62 or a deleted row.
pub(crate) fn delete_by_pubkey_and_ids(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    pubkey: &Pubkey,
    ids: &[EventId],
    now: DateTime<Utc>,
) -> Result<u64, StorageError> {
    let mut affected = 0;
    for id in ids {
        let Some(value) = databases.events.get(txn, id.as_bytes())? else {
            continue;
        };
        let record = rows::decode_event(value)?;
        if record.event.pubkey != *pubkey
            || kind_of(&record)? == REQUEST_TO_VANISH
            || record.deleted_at.is_some()
        {
            continue;
        }
        soft_delete(txn, databases, &record, now)?;
        affected += 1;
    }
    Ok(affected)
}

/// `delete_by_pubkey_except_kinds`: every other live row of one author, soft-deleted.
pub(crate) fn delete_by_pubkey_except_kinds(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    pubkey: &Pubkey,
    excluded_kinds: &[Kind],
    now: DateTime<Utc>,
) -> Result<u64, StorageError> {
    let excluded: Vec<i32> = excluded_kinds
        .iter()
        .map(|kind| i32::try_from(kind.0).unwrap_or(i32::MAX))
        .collect();
    let mut keys = Vec::new();
    for entry in databases
        .events_by_author
        .prefix_iter(txn, pubkey.as_bytes())?
    {
        let (key, _) = entry?;
        keys.push(key.to_vec());
    }

    let mut affected = 0;
    for key in keys {
        let header = author_key_header(&key)?;
        if excluded.contains(&header.kind) {
            continue;
        }
        let id = header.event_id;
        let Some(value) = databases.events.get(txn, id.as_bytes())? else {
            continue;
        };
        let record = rows::decode_event(value)?;
        if record.deleted_at.is_some() {
            continue;
        }
        soft_delete(txn, databases, &record, now)?;
        affected += 1;
    }
    Ok(affected)
}

/// `has_active_request_to_vanish`: a live kind-62 row exists for the pubkey.
pub(crate) fn has_active_request_to_vanish(
    txn: &RoTxn<'_>,
    databases: &Databases,
    pubkey: &Pubkey,
) -> Result<bool, StorageError> {
    let mut prefix = pubkey.as_bytes().to_vec();
    prefix.extend_from_slice(&encoding::i32_key(REQUEST_TO_VANISH));
    for entry in databases.events_by_author.prefix_iter(txn, &prefix)? {
        let (key, _) = entry?;
        let id = header_id(key, 44, "events_by_author")?;
        let Some(value) = databases.events.get(txn, id.as_bytes())? else {
            continue;
        };
        if !rows::event_header(value)?.deleted {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `delete_expired_and_retained`: one hard-delete batch of at most
/// [`RETENTION_BATCH_SIZE`] rows, gathered in the capture's index order and classified
/// deleted, then expired, then over-retention.
// shortcut: retention takes its 1000 candidates in a fixed order (deleted, expiring,
// created_at) where Postgres' planner chooses; upgrade when a deployment exceeds 1000
// qualifying rows per pass and the mix, not the total, starts to matter (spec Assumption 10).
pub(crate) fn delete_expired_and_retained(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    options: &EventRetentionOptions,
    now: i64,
) -> Result<EventPurgeCounts, StorageError> {
    let Some(max_days) = options.max_days.filter(|days| *days > 0) else {
        return Ok(EventPurgeCounts::default());
    };
    let retention_limit = now.saturating_sub(max_days.saturating_mul(86_400));
    let kinds = retention_kinds(options.kind_whitelist.as_deref());
    let pubkeys: Vec<[u8; 32]> = options
        .pubkey_whitelist
        .iter()
        .flatten()
        .map(|pubkey| encoding::hex_bytes(&pubkey.0))
        .filter_map(|bytes| bytes.try_into().ok())
        .collect();

    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for entry in databases.events_deleted.iter(txn)? {
        let (key, _) = entry?;
        let id = header_id(key, 8, "events_deleted")?;
        gather(
            txn,
            databases,
            id,
            now,
            retention_limit,
            &kinds,
            &pubkeys,
            &mut candidates,
            &mut seen,
        )?;
        if candidates.len() >= RETENTION_BATCH_SIZE {
            break;
        }
    }
    if candidates.len() < RETENTION_BATCH_SIZE {
        for entry in databases.events_expiring.iter(txn)? {
            let (key, _) = entry?;
            let id = header_id(key, 8, "events_expiring")?;
            gather(
                txn,
                databases,
                id,
                now,
                retention_limit,
                &kinds,
                &pubkeys,
                &mut candidates,
                &mut seen,
            )?;
            if candidates.len() >= RETENTION_BATCH_SIZE {
                break;
            }
        }
    }
    if candidates.len() < RETENTION_BATCH_SIZE {
        let lower = encoding::i64_key(i64::MIN).to_vec();
        let mut upper = encoding::i64_key(retention_limit.saturating_sub(1)).to_vec();
        upper.extend([0xff; 32]);
        let range = encoding::bounds(&lower, &upper);
        for entry in databases.events_by_created_at.range(txn, &range)? {
            let (key, _) = entry?;
            let id = header_id(key, 8, "events_by_created_at")?;
            if candidates.len() >= RETENTION_BATCH_SIZE {
                break;
            }
            gather(
                txn,
                databases,
                id,
                now,
                retention_limit,
                &kinds,
                &pubkeys,
                &mut candidates,
                &mut seen,
            )?;
        }
    }

    let mut counts = EventPurgeCounts::default();
    for id in candidates {
        let Some(value) = databases.events.get(txn, id.as_bytes())? else {
            continue;
        };
        let header = rows::event_header(value)?;
        if header.deleted {
            counts.deleted += 1;
        } else if header.expires_at.is_some_and(|expires_at| expires_at < now) {
            counts.expired += 1;
        } else if header.created_at < retention_limit {
            counts.retained += 1;
        } else {
            continue;
        }
        let record = rows::decode_event(value)?;
        hard_delete(txn, databases, &record)?;
    }
    Ok(counts)
}

/// Adds one retention candidate when it qualifies and is not protected, deduplicating.
#[allow(clippy::too_many_arguments)]
fn gather(
    txn: &RoTxn<'_>,
    databases: &Databases,
    id: EventId,
    now: i64,
    retention_limit: i64,
    kinds: &[KindSelector],
    pubkeys: &[[u8; 32]],
    candidates: &mut Vec<EventId>,
    seen: &mut HashSet<[u8; 32]>,
) -> Result<(), StorageError> {
    let Some(value) = databases.events.get(txn, id.as_bytes())? else {
        return Ok(());
    };
    let header = rows::event_header(value)?;
    if whitelisted(header.kind, kinds) || pubkeys.contains(header.pubkey.as_bytes()) {
        return Ok(());
    }
    let qualifies = header.deleted
        || header.expires_at.is_some_and(|expires_at| expires_at < now)
        || header.created_at < retention_limit;
    if qualifies && seen.insert(*id.as_bytes()) {
        candidates.push(id);
    }
    Ok(())
}

/// The capture's deduplicated whitelist, which always keeps kind 62.
fn retention_kinds(configured: Option<&[KindSelector]>) -> Vec<KindSelector> {
    let mut whitelist: Vec<KindSelector> = Vec::new();
    for selector in configured.unwrap_or_default() {
        if !whitelist.contains(selector) {
            whitelist.push(*selector);
        }
    }
    let vanish = KindSelector::Single(Kind(REQUEST_TO_VANISH as u64));
    if !whitelist.contains(&vanish) {
        whitelist.push(vanish);
    }
    whitelist
}

fn whitelisted(kind: i32, selectors: &[KindSelector]) -> bool {
    selectors.iter().any(|selector| match selector {
        KindSelector::Single(selector) => i32::try_from(selector.0).unwrap_or(i32::MAX) == kind,
        KindSelector::Range([start, end]) => {
            let start = i32::try_from(start.0).unwrap_or(i32::MAX);
            let end = i32::try_from(end.0).unwrap_or(i32::MAX);
            kind >= start && kind <= end
        }
    })
}

fn kind_of(record: &EventRecord) -> Result<i32, StorageError> {
    i32::try_from(record.event.kind.0).map_err(|_| StorageError::ValueOutOfRange {
        column: "event_kind",
        value: record.event.kind.0.to_string(),
    })
}

// ---------------------------------------------------------------------------------------
// Read paths.
// ---------------------------------------------------------------------------------------

/// Counts a key a read evaluated. Only the tests read the count, so a release build drops it.
fn key_evaluated() {
    #[cfg(test)]
    probes::key();
}

/// Counts an event body a read decoded. Only the tests read the count.
fn body_decoded() {
    #[cfg(test)]
    probes::decode();
}

/// The work counters the cost tests assert on: a page's cost is its keys evaluated and its
/// bodies decoded, and neither is visible in its result.
#[cfg(test)]
mod probes {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Serialises the tests that count work, so one cannot read another's numbers.
    pub(super) static COUNTING: Mutex<()> = Mutex::new(());

    static KEYS: AtomicUsize = AtomicUsize::new(0);
    static DECODES: AtomicUsize = AtomicUsize::new(0);

    pub(super) fn reset() {
        KEYS.store(0, Ordering::Relaxed);
        DECODES.store(0, Ordering::Relaxed);
    }

    pub(super) fn key() {
        KEYS.fetch_add(1, Ordering::Relaxed);
    }

    pub(super) fn decode() {
        DECODES.fetch_add(1, Ordering::Relaxed);
    }

    pub(super) fn keys() -> usize {
        KEYS.load(Ordering::Relaxed)
    }

    pub(super) fn decodes() -> usize {
        DECODES.load(Ordering::Relaxed)
    }
}

/// One database's inclusive key range.
type KeyRange = (Vec<u8>, Vec<u8>);

/// The index one filter is answered from, the ranges within it, and what a key proves.
struct Plan<'a> {
    database: Database<Bytes, Bytes>,
    path: AccessPath,
    ranges: Vec<KeyRange>,
    /// Whether a range's own key order is the page's order, so a range stops once the page is
    /// full instead of being walked whole.
    ordered: bool,
    /// The tag family the ranges were built from, with its criteria in the criteria's order —
    /// `tag_ranges` builds one range per criterion. A key in these ranges has already proved
    /// that family, so the row's body is decoded only for the filter's other tag families.
    tag: Option<(&'a str, &'a [String])>,
}

/// One reconciliation batch still running on the blocking pool, with the cursor it returns.
type PendingBatch = JoinHandle<Result<(Vec<ReconciliationItem>, Position), StorageError>>;

/// The index one filter is answered from, and how its keys are read back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AccessPath {
    Ids,
    Authors,
    Tags,
    CreatedAt,
}

/// The page of keys one filter matches, in the capture's order.
pub(crate) fn page(
    txn: &RoTxn<'_>,
    databases: &Databases,
    filters: &[Filter],
    gates: &Gates,
    now: i64,
) -> Result<Vec<(i64, EventId)>, StorageError> {
    if filters.is_empty() {
        return Err(StorageError::InvalidArgument {
            message: "Filters cannot be empty",
        });
    }

    let mut union = Vec::new();
    let mut seen = HashSet::new();
    for filter in filters {
        for candidate in branch(
            txn,
            databases,
            filter,
            gates,
            now,
            false,
            page_limit(filter),
        )? {
            if seen.insert(candidate) {
                union.push(candidate);
            }
        }
    }
    sort_page(&mut union, filters[0].limit.is_some());
    Ok(union)
}

/// The count of the live ids the filters match, deduplicated across filters.
///
/// A count has no page, so it holds no candidate set: each filter counts the rows it visits and
/// skips one the count already holds — a row of an earlier filter's page when that filter had a
/// limit (a page is at most [`MAX_PAGE_KEYS`] ids), or one its predicate matches when it had
/// none — which is the capture's `UNION`.
pub(crate) fn count(
    txn: &RoTxn<'_>,
    databases: &Databases,
    filters: &[Filter],
    gates: &Gates,
    now: i64,
) -> Result<u64, StorageError> {
    if filters.is_empty() {
        return Err(StorageError::InvalidArgument {
            message: "Filters cannot be empty",
        });
    }

    let mut counted = Counted::default();
    let mut total = 0;
    for filter in filters {
        total += match filter.limit {
            Some(limit) => {
                let page = branch(txn, databases, filter, gates, now, true, count_limit(limit))?;
                let mut fresh = 0;
                for (_, id) in &page {
                    if !already_counted(txn, databases, &counted, gates, now, id)? {
                        fresh += 1;
                    }
                }
                counted.pages.push(page.iter().map(|(_, id)| *id).collect());
                fresh
            }
            None => {
                let fresh = count_matches(txn, databases, filter, &counted, gates, now)?;
                counted.predicates.push(filter);
                fresh
            }
        };
    }
    Ok(total)
}

/// What a count has already counted: bounded by [`MAX_PAGE_KEYS`] per limited filter.
#[derive(Default)]
struct Counted<'a> {
    /// The ids of every earlier filter that had a limit: its whole page.
    pages: Vec<HashSet<EventId>>,
    /// Every earlier filter without a limit, whose page is every row its predicate matches.
    predicates: Vec<&'a Filter>,
}

/// Whether the count already holds `id`, so counting it again would count the row twice.
fn already_counted(
    txn: &RoTxn<'_>,
    databases: &Databases,
    counted: &Counted<'_>,
    gates: &Gates,
    now: i64,
    id: &EventId,
) -> Result<bool, StorageError> {
    if counted.pages.iter().any(|page| page.contains(id)) {
        return Ok(true);
    }
    for filter in &counted.predicates {
        let matcher = Matcher {
            filter,
            gates,
            now,
            live: true,
            proven: None,
        };
        if matcher.matches(txn, databases, id)?.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether a criterion of the filter's own tag family, other than the one this range was built
/// from, also selects the row. One event can carry two values the family asks for, and the
/// criterion whose range comes first answers for it, so the row is counted once.
///
/// This is the one place a count reads an event's tags instead of its key: the key names a
/// single value, and which values the event also carries is in the body.
fn earlier_criterion_selects(
    txn: &RoTxn<'_>,
    databases: &Databases,
    plan: &Plan<'_>,
    index: usize,
    id: &EventId,
) -> Result<bool, StorageError> {
    let Some((name, criteria)) = plan.tag else {
        return Ok(false);
    };
    if index == 0 {
        return Ok(false);
    }
    let Some(value) = databases.events.get(txn, id.as_bytes())? else {
        return Ok(false);
    };
    let record = rows::decode_event(value)?;
    Ok(criteria
        .iter()
        .take(index)
        .any(|earlier| record_has_tag(&record, name, std::slice::from_ref(earlier))))
}

/// Counts the live rows one unlimited filter matches that the count does not already hold.
///
/// Every range is walked whole — a count has no page to stop at — and a row two of them select
/// is counted once, at the first criterion's range.
fn count_matches(
    txn: &RoTxn<'_>,
    databases: &Databases,
    filter: &Filter,
    counted: &Counted<'_>,
    gates: &Gates,
    now: i64,
) -> Result<u64, StorageError> {
    if !admits(filter, gates)? {
        return Ok(0);
    }
    let plan = plan(filter, databases);
    let matcher = Matcher {
        filter,
        gates,
        now,
        live: true,
        proven: plan.tag.map(|(name, _)| name),
    };
    let mut total = 0;
    for (index, (low, high)) in plan.ranges.iter().enumerate() {
        let range = encoding::bounds(low, high);
        for entry in plan.database.range(txn, &range)? {
            let (key, _) = entry?;
            key_evaluated();
            if let Some((name, criteria)) = plan.tag
                && !tag_value_matches(name == "g", criteria, encoding::tag_value(key)?)
            {
                continue;
            }
            let Some((_, id)) = candidate(txn, databases, plan.path, key)? else {
                continue;
            };
            if matcher.matches(txn, databases, &id)?.is_some()
                && !already_counted(txn, databases, counted, gates, now, &id)?
                && !earlier_criterion_selects(txn, databases, &plan, index, &id)?
            {
                total += 1;
            }
        }
    }
    Ok(total)
}

/// The page a filter may materialise: its own limit or the capture's default, and never more
/// than [`MAX_PAGE_KEYS`] however large the limit on the wire is.
fn page_limit(filter: &Filter) -> usize {
    count_limit(filter.limit.unwrap_or(DEFAULT_FILTER_LIMIT))
}

/// A wire limit clamped to [`MAX_PAGE_KEYS`], so no request chooses the size of an allocation.
fn count_limit(limit: u64) -> usize {
    usize::try_from(limit.min(MAX_PAGE_KEYS as u64)).unwrap_or(MAX_PAGE_KEYS)
}

/// The refusals and short-circuits every read applies before it seeks an index.
///
/// `true` means the filter can match rows; `false` means a criterion family is present but
/// empty, which is the capture's `1 = 0`.
fn admits(filter: &Filter, gates: &Gates) -> Result<bool, StorageError> {
    if gates.nip50
        && filter
            .search
            .as_deref()
            .is_some_and(|search| !search.trim().is_empty())
    {
        return Err(StorageError::NotImplemented {
            module: "storage::lmdb::nip50_search",
        });
    }
    Ok(!(filter.ids.as_ref().is_some_and(|ids| ids.is_empty())
        || filter
            .authors
            .as_ref()
            .is_some_and(|authors| authors.is_empty())
        || filter
            .tags
            .iter()
            .any(|(key, criteria)| generic_tag_name(key).is_some() && criteria.is_empty())))
}

/// One filter's page: the best `limit` keys it matches, ordered as the capture's branch is.
///
/// The resident set is the page, never the range. A range whose key order is the page's order
/// stops as soon as the page is full (keeping every row at the boundary timestamp, so a tie is
/// the capture's); the other ranges offer their matches to a buffer of at most `2 × limit`,
/// which is cut back to the best `limit` whenever it fills.
fn branch(
    txn: &RoTxn<'_>,
    databases: &Databases,
    filter: &Filter,
    gates: &Gates,
    now: i64,
    live: bool,
    limit: usize,
) -> Result<Vec<(i64, EventId)>, StorageError> {
    if !admits(filter, gates)? {
        return Ok(Vec::new());
    }

    let plan = plan(filter, databases);
    // A `tags` range is built from the family's own criteria, so every key in it satisfies that
    // family: the matcher skips it and no body is decoded for it.
    let matcher = Matcher {
        filter,
        gates,
        now,
        live,
        proven: plan.tag.map(|(name, _)| name),
    };
    let descending = filter.limit.is_some();
    let mut page = Page::new(descending);
    for (low, high) in &plan.ranges {
        let range = encoding::bounds(low, high);
        let mut boundary: Option<i64> = None;
        for entry in scan(plan.database, txn, &range, plan.ordered && descending)? {
            let (key, _) = entry?;
            key_evaluated();
            let Some(found) = candidate(txn, databases, plan.path, key)? else {
                continue;
            };
            if plan.ordered && boundary.is_some_and(|bound| past(bound, found.0, descending)) {
                break;
            }
            if matcher.matches(txn, databases, &found.1)?.is_some() {
                page.offer(found, limit);
                if plan.ordered && page.len() >= limit {
                    boundary = Some(found.0);
                }
            }
        }
    }
    Ok(page.finish(limit))
}

/// Whether a key's timestamp is past the timestamp a full page stopped at.
fn past(boundary: i64, created_at: i64, descending: bool) -> bool {
    if descending {
        created_at < boundary
    } else {
        created_at > boundary
    }
}

/// A page under construction: at most `2 × limit` entries, cut back to the best `limit`.
struct Page {
    entries: Vec<(i64, EventId)>,
    seen: HashSet<EventId>,
    descending: bool,
}

impl Page {
    fn new(descending: bool) -> Self {
        Self {
            entries: Vec::new(),
            seen: HashSet::new(),
            descending,
        }
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    /// Keeps `key` if it can still be among the best `limit` the page has seen.
    fn offer(&mut self, key: (i64, EventId), limit: usize) {
        if limit == 0 || !self.seen.insert(key.1) {
            return;
        }
        self.entries.push(key);
        if self.entries.len() >= limit.saturating_mul(2) {
            self.cut(limit);
        }
    }

    fn finish(mut self, limit: usize) -> Vec<(i64, EventId)> {
        self.cut(limit);
        self.entries
    }

    fn cut(&mut self, limit: usize) {
        sort_page(&mut self.entries, self.descending);
        self.entries.truncate(limit);
        self.seen = self.entries.iter().map(|(_, id)| *id).collect();
    }
}

/// One range's keys, in the plan's order.
enum Scan<'txn> {
    Ascending(heed::RoRange<'txn, Bytes, Bytes>),
    Descending(heed::RoRevRange<'txn, Bytes, Bytes>),
}

impl<'txn> Iterator for Scan<'txn> {
    type Item = Result<(&'txn [u8], &'txn [u8]), heed::Error>;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Ascending(range) => range.next(),
            Self::Descending(range) => range.next(),
        }
    }
}

fn scan<'txn>(
    database: Database<Bytes, Bytes>,
    txn: &'txn RoTxn<'_>,
    range: &(Bound<&[u8]>, Bound<&[u8]>),
    descending: bool,
) -> Result<Scan<'txn>, StorageError> {
    Ok(if descending {
        Scan::Descending(database.rev_range(txn, range)?)
    } else {
        Scan::Ascending(database.range(txn, range)?)
    })
}

fn sort_page(page: &mut [(i64, EventId)], descending: bool) {
    if descending {
        page.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    } else {
        page.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    }
}

/// The index a filter is answered from, the ranges within it, and whether a range's key order
/// is the page's order.
///
/// shortcut: `ids`, an author prefix and a `#g` prefix name no index that runs in time order, so
/// those pages are bounded in memory but walk their whole time-bounded range; upgrade when a
/// deployment's range outgrows one request, which needs a second index ordered by time.
fn plan<'a>(filter: &'a Filter, databases: &Databases) -> Plan<'a> {
    if let Some(ids) = &filter.ids
        && !ids.is_empty()
    {
        return Plan {
            database: databases.events,
            path: AccessPath::Ids,
            ranges: encoding::hex_ranges(ids, 0),
            // The `events` key is the id, so the range runs in id order, not time order.
            ordered: false,
            tag: None,
        };
    }
    if let Some(authors) = &filter.authors
        && !authors.is_empty()
    {
        if let Some(kinds) = &filter.kinds
            && !kinds.is_empty()
        {
            return Plan {
                database: databases.events_by_author,
                path: AccessPath::Authors,
                ranges: author_kind_ranges(authors, kinds),
                // A range is `pubkey ‖ kind ‖ created_at ‖ event_id`, so it runs in time order
                // only when the criterion is a whole pubkey and the range one author.
                ordered: authors.iter().all(|criterion| criterion.len() == 64),
                tag: None,
            };
        }
        // Without kinds the author index runs in kind order before `created_at`, so a page
        // ordered by time has no early stop there. The created-at index is the capture's own
        // path for this shape — ADR 0003 measured 5 508 rows discarded to return 500 for the
        // kind-only form — and its order *is* the page order, so the page stops when full.
        //
        // shortcut: a quiet author's page therefore scans further into the created-at index
        // than the author's own timeline would; upgrade when statistics can choose between the
        // two, which is the benchmark job's (ADR 0010).
        return Plan {
            database: databases.events_by_created_at,
            path: AccessPath::CreatedAt,
            ranges: created_at_ranges(filter),
            ordered: true,
            tag: None,
        };
    }
    if let Some((name, criteria)) = tag_path(filter) {
        return Plan {
            database: databases.tags,
            path: AccessPath::Tags,
            ranges: encoding::tag_ranges(name, criteria),
            // An exact criterion's range runs `created_at` under one value; a `#g` prefix range
            // spans values, so its keys are in value order and the range is walked whole.
            ordered: name != "g" || criteria.iter().all(|criterion| !criterion.ends_with('*')),
            tag: Some((name, criteria)),
        };
    }
    Plan {
        database: databases.events_by_created_at,
        path: AccessPath::CreatedAt,
        ranges: created_at_ranges(filter),
        ordered: true,
        tag: None,
    }
}

/// One range per author criterion and kind on `events_by_author`, whose key is
/// `pubkey ‖ kind ‖ created_at ‖ event_id`: the `pubkey ‖ kind ‖ created_at` ordering the layout
/// writes is what lets a page for one author and one kind stop as soon as it is full.
///
/// The author bounds are the index's whole 32-byte pubkey field, so a prefix criterion's kind
/// is compared against the key's own kind bytes; a criterion another already covers, and a
/// repeated kind, seek one range, so a count cannot visit their keys twice.
fn author_kind_ranges(authors: &[String], kinds: &[Kind]) -> Vec<KeyRange> {
    let mut ranges = Vec::with_capacity(authors.len() * kinds.len());
    for (low, high) in encoding::hex_ranges(authors, 0) {
        for kind in kinds {
            let kind = encoding::i32_key(i32::try_from(kind.0).unwrap_or(i32::MAX));
            let mut lower = low.clone();
            lower.extend_from_slice(&kind);
            let mut upper = high.clone();
            upper.extend_from_slice(&kind);
            upper.extend(std::iter::repeat_n(0xff, 8 + 32));
            ranges.push((lower, upper));
        }
    }
    encoding::disjoint(ranges)
}

/// The first tag criterion the capture treats as a query: `#` plus one ASCII letter with a
/// non-empty list.
fn tag_path(filter: &Filter) -> Option<(&str, &[String])> {
    filter.tags.iter().find_map(|(key, criteria)| {
        generic_tag_name(key)
            .filter(|_| !criteria.is_empty())
            .map(|name| (name, criteria.as_slice()))
    })
}

fn created_at_ranges(filter: &Filter) -> Vec<(Vec<u8>, Vec<u8>)> {
    let lower = match filter.since {
        Some(since) => encoding::i64_key(since).to_vec(),
        None => Vec::new(),
    };
    let upper = match filter.until {
        Some(until) => {
            let mut upper = encoding::i64_key(until).to_vec();
            upper.extend([0xff; 32]);
            upper
        }
        None => vec![0xff; 64],
    };
    vec![(lower, upper)]
}

/// The `(created_at, event_id)` one index key carries, when the key carries it.
fn key_candidate(path: AccessPath, key: &[u8]) -> Result<Option<(i64, EventId)>, StorageError> {
    match path {
        AccessPath::Ids => Ok(None),
        AccessPath::Authors => {
            if key.len() != 76 {
                return Err(encoding::invalid(
                    "events_by_author",
                    format!("a key of {} bytes", key.len()),
                ));
            }
            Ok(Some((
                encoding::i64_from_key(&key[36..44])?,
                encoding::event_id_from(&key[44..76])?,
            )))
        }
        AccessPath::Tags => {
            if key.len() < 42 {
                return Err(encoding::invalid(
                    "tags",
                    format!("a key of {} bytes", key.len()),
                ));
            }
            let start = key.len() - 40;
            Ok(Some((
                encoding::i64_from_key(&key[start..start + 8])?,
                encoding::event_id_from(&key[start + 8..])?,
            )))
        }
        AccessPath::CreatedAt => {
            if key.len() != 40 {
                return Err(encoding::invalid(
                    "events_by_created_at",
                    format!("a key of {} bytes", key.len()),
                ));
            }
            Ok(Some((
                encoding::i64_from_key(&key[..8])?,
                encoding::event_id_from(&key[8..])?,
            )))
        }
    }
}

/// A candidate whose `created_at` is only in the value, read from the header.
fn candidate(
    txn: &RoTxn<'_>,
    databases: &Databases,
    path: AccessPath,
    key: &[u8],
) -> Result<Option<(i64, EventId)>, StorageError> {
    if let Some(candidate) = key_candidate(path, key)? {
        return Ok(Some(candidate));
    }
    let id = encoding::event_id_from(key)?;
    let Some(value) = databases.events.get(txn, id.as_bytes())? else {
        return Ok(None);
    };
    Ok(Some((rows::event_header(value)?.created_at, id)))
}

/// One filter's criteria, evaluated against a stored event.
struct Matcher<'a> {
    filter: &'a Filter,
    gates: &'a Gates,
    now: i64,
    live: bool,
    /// The tag family the index range that selected the row has already proved, if any.
    proven: Option<&'a str>,
}

impl Matcher<'_> {
    fn matches(
        &self,
        txn: &RoTxn<'_>,
        databases: &Databases,
        id: &EventId,
    ) -> Result<Option<EventHeader>, StorageError> {
        let Some(value) = databases.events.get(txn, id.as_bytes())? else {
            return Ok(None);
        };
        let header = rows::event_header(value)?;

        if self.live
            && (header.deleted
                || header
                    .expires_at
                    .is_some_and(|expires_at| expires_at <= self.now))
        {
            return Ok(None);
        }
        if let Some(ids) = &self.filter.ids
            && !ids
                .iter()
                .any(|criterion| encoding::hex_matches(id.as_bytes(), criterion))
        {
            return Ok(None);
        }
        if let Some(authors) = &self.filter.authors
            && !authors
                .iter()
                .any(|criterion| encoding::hex_matches(header.pubkey.as_bytes(), criterion))
        {
            return Ok(None);
        }
        if let Some(kinds) = &self.filter.kinds
            && !kinds
                .iter()
                .any(|kind| i32::try_from(kind.0).unwrap_or(i32::MAX) == header.kind)
        {
            return Ok(None);
        }
        if let Some(since) = self.filter.since
            && header.created_at < since
        {
            return Ok(None);
        }
        if let Some(until) = self.filter.until
            && header.created_at > until
        {
            return Ok(None);
        }
        if self.gates.nip56 && self.reported(txn, databases, id, &header.pubkey)? {
            return Ok(None);
        }
        if self.carries_other_tag_criteria() && {
            body_decoded();
            !tag_criteria_match(&self.filter.tags, &rows::decode_event(value)?, self.proven)
        } {
            return Ok(None);
        }
        Ok(Some(header))
    }

    /// Whether the filter carries a tag family the row's key has not already proved. A row the
    /// `tags` index selected needs no decode when that is the filter's only family.
    fn carries_other_tag_criteria(&self) -> bool {
        self.filter
            .tags
            .keys()
            .filter_map(|key| generic_tag_name(key))
            .any(|name| Some(name) != self.proven)
    }

    /// The capture's `NOT EXISTS (… reports …)`: one lookup per target column, by prefix so the
    /// width of `reports.id` is `metadata`'s business and not restated here.
    fn reported(
        &self,
        txn: &RoTxn<'_>,
        databases: &Databases,
        id: &EventId,
        pubkey: &Pubkey,
    ) -> Result<bool, StorageError> {
        if exists_with_prefix(databases.reports_actionable_event, txn, id.as_bytes())? {
            return Ok(true);
        }
        exists_with_prefix(databases.reports_actionable_pubkey, txn, pubkey.as_bytes())
    }
}

/// Whether `database` holds any key starting with `prefix`.
fn exists_with_prefix(
    database: Database<Bytes, Bytes>,
    txn: &RoTxn<'_>,
    prefix: &[u8],
) -> Result<bool, StorageError> {
    Ok(database
        .prefix_iter(txn, prefix)?
        .next()
        .transpose()?
        .is_some())
}

/// The capture's `isGenericTagQuery`: `#` plus one ASCII letter.
pub(crate) fn generic_tag_name(key: &str) -> Option<&str> {
    let mut characters = key.chars();
    if characters.next() != Some('#') {
        return None;
    }
    let name = characters.next()?;
    if characters.next().is_some() || !name.is_ascii_alphabetic() {
        return None;
    }
    Some(&key[1..2])
}

/// Whether a tag value satisfies one of a family's criteria: an exact value, and only `#g`
/// honours a trailing `*` as a prefix.
///
/// `event_tags` holds no empty value, so an empty one satisfies nothing. The criterion a `tags`
/// key carries is checked here, from the key, and the same rule answers the decoded record.
fn tag_value_matches(is_geohash: bool, criteria: &[String], value: &str) -> bool {
    !value.is_empty()
        && criteria.iter().any(|criterion| {
            match criterion.strip_suffix('*').filter(|_| is_geohash) {
                Some(prefix) => value.starts_with(prefix),
                None => value == criterion,
            }
        })
}

/// Whether an event carries a tag called `name` whose value satisfies one of `criteria`.
fn record_has_tag(record: &EventRecord, name: &str, criteria: &[String]) -> bool {
    let is_geohash = name == "g";
    record.event.tags.iter().any(|tag| {
        tag.first().map(String::as_str) == Some(name)
            && tag
                .get(1)
                .is_some_and(|value| tag_value_matches(is_geohash, criteria, value))
    })
}

/// Every tag criterion of a filter, under the capture's rules, except the family `proven`.
fn tag_criteria_match(
    tags: &BTreeMap<String, Vec<String>>,
    record: &EventRecord,
    proven: Option<&str>,
) -> bool {
    for (key, criteria) in tags {
        let Some(name) = generic_tag_name(key) else {
            continue;
        };
        if Some(name) == proven {
            continue;
        }
        if criteria.is_empty() || !record_has_tag(record, name, criteria) {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------------------
// Streams.
// ---------------------------------------------------------------------------------------

/// Where a reconciliation batch resumes: the range it is on, and the last key it evaluated.
struct Position {
    index: usize,
    after: Option<Vec<u8>>,
}

impl Position {
    fn new() -> Self {
        Self {
            index: 0,
            after: None,
        }
    }
}

/// Reads one page of values in batches of [`STREAM_BATCH_ITEMS`], one read transaction per
/// poll, so a stream that is dropped pins no pages.
///
/// It holds the page `find_by_filters` already collected — at most [`MAX_PAGE_KEYS`] ids — and
/// copies each batch's values out of it; it is the reconciliation stream, not this one, that
/// holds only a cursor key.
///
/// shortcut: a stream is not a snapshot — a row written or deleted between two batches may
/// appear or vanish; upgrade when a caller needs a stable view, per ADR 0003 trigger 1 and the
/// benchmark job, which would buy the snapshot back with a held transaction.
pub(crate) struct ValuesStream {
    env: Env,
    databases: Databases,
    keys: std::vec::IntoIter<EventId>,
    pending: Option<JoinHandle<Result<Vec<EventRecord>, StorageError>>>,
    buffer: std::vec::IntoIter<EventRecord>,
    finished: bool,
}

impl ValuesStream {
    pub(crate) fn new(env: Env, databases: Databases, page: &[(i64, EventId)]) -> Self {
        Self {
            env,
            databases,
            keys: page
                .iter()
                .map(|(_, id)| *id)
                .collect::<Vec<_>>()
                .into_iter(),
            pending: None,
            buffer: Vec::new().into_iter(),
            finished: false,
        }
    }
}

impl Stream for ValuesStream {
    type Item = Result<EventRecord, StorageError>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        loop {
            if let Some(record) = this.buffer.next() {
                return Poll::Ready(Some(Ok(record)));
            }
            if let Some(handle) = this.pending.as_mut() {
                match Pin::new(handle).poll(context) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(joined) => {
                        this.pending = None;
                        match joined {
                            Ok(Ok(records)) => this.buffer = records.into_iter(),
                            Ok(Err(error)) => {
                                this.finished = true;
                                return Poll::Ready(Some(Err(error)));
                            }
                            Err(_) => {
                                this.finished = true;
                                return Poll::Ready(Some(Err(StorageError::LmdbTaskCancelled)));
                            }
                        }
                    }
                }
                continue;
            }
            if this.finished {
                return Poll::Ready(None);
            }
            let batch: Vec<EventId> = this.keys.by_ref().take(STREAM_BATCH_ITEMS).collect();
            if batch.is_empty() {
                this.finished = true;
                return Poll::Ready(None);
            }
            let env = this.env.clone();
            let database = this.databases.events;
            this.pending = Some(tokio::task::spawn_blocking(move || {
                let transaction = env.read_txn()?;
                let mut records = Vec::with_capacity(batch.len());
                for id in batch {
                    let Some(value) = database.get(&transaction, id.as_bytes())? else {
                        continue;
                    };
                    records.push(rows::decode_event(value)?);
                }
                Ok(records)
            }));
        }
    }
}

/// Yields the live `(created_at, event_id)` pairs a reconciliation compares, oldest first, in
/// batches of at most [`STREAM_BATCH_ITEMS`] items or [`STREAM_BATCH_KEYS`] evaluated keys —
/// whichever comes first — with one read transaction per poll.
pub(crate) struct ReconciliationStream {
    env: Env,
    databases: Databases,
    filter: Filter,
    gates: Gates,
    now: i64,
    range_count: usize,
    position: Position,
    pending: Option<PendingBatch>,
    buffer: std::vec::IntoIter<ReconciliationItem>,
    finished: bool,
}

impl ReconciliationStream {
    pub(crate) fn new(
        env: Env,
        databases: Databases,
        filter: &Filter,
        gates: Gates,
        now: i64,
    ) -> Self {
        let range_count = stream_plan(filter, &databases).ranges.len();
        Self {
            env,
            databases,
            filter: filter.clone(),
            gates,
            now,
            range_count,
            position: Position::new(),
            pending: None,
            buffer: Vec::new().into_iter(),
            finished: false,
        }
    }
}

impl Stream for ReconciliationStream {
    type Item = Result<ReconciliationItem, StorageError>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        loop {
            if let Some(item) = this.buffer.next() {
                return Poll::Ready(Some(Ok(item)));
            }
            if let Some(handle) = this.pending.as_mut() {
                match Pin::new(handle).poll(context) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(joined) => {
                        this.pending = None;
                        match joined {
                            Ok(Ok((items, position))) => {
                                this.position = position;
                                this.buffer = items.into_iter();
                            }
                            Ok(Err(error)) => {
                                this.finished = true;
                                return Poll::Ready(Some(Err(error)));
                            }
                            Err(_) => {
                                this.finished = true;
                                return Poll::Ready(Some(Err(StorageError::LmdbTaskCancelled)));
                            }
                        }
                    }
                }
                continue;
            }
            if this.finished {
                return Poll::Ready(None);
            }
            let env = this.env.clone();
            let databases = this.databases;
            let filter = this.filter.clone();
            let gates = this.gates;
            let now = this.now;
            let mut position = std::mem::replace(&mut this.position, Position::new());
            let exhausted = position.index >= this.range_count;
            if exhausted {
                this.finished = true;
                return Poll::Ready(None);
            }
            this.pending = Some(tokio::task::spawn_blocking(move || {
                let transaction = env.read_txn()?;
                let items = scan_batch(
                    &transaction,
                    &databases,
                    &filter,
                    &gates,
                    now,
                    &mut position,
                )?;
                Ok((items, position))
            }));
        }
    }
}

/// The plan a reconciliation scans with.
///
/// The stream promises the pairs oldest first, and only a single range that runs in `created_at`
/// order gives that without materialising the result: a filter the faster index narrows to one
/// such range (`{authors: [a], kinds: [k]}` or one exact tag value) is scanned there, and
/// anything else — several ranges, or a range that runs in key order — scans the created-at
/// index, whose order *is* the promise.
fn stream_plan<'a>(filter: &'a Filter, databases: &Databases) -> Plan<'a> {
    let chosen = plan(filter, databases);
    if chosen.ordered && chosen.ranges.len() == 1 {
        return chosen;
    }
    Plan {
        database: databases.events_by_created_at,
        path: AccessPath::CreatedAt,
        ranges: created_at_ranges(filter),
        ordered: true,
        tag: None,
    }
}

/// One batch of a reconciliation scan: at most [`STREAM_BATCH_ITEMS`] items or
/// [`STREAM_BATCH_KEYS`] evaluated keys, whichever comes first, resuming after the last key the
/// previous batch read.
///
/// The key cap is what keeps one poll short however few of the keys it walks match: every
/// transaction a stream opens is closed by the poll that opened it, so no read pins a page while
/// the writer works.
fn scan_batch(
    txn: &RoTxn<'_>,
    databases: &Databases,
    filter: &Filter,
    gates: &Gates,
    now: i64,
    position: &mut Position,
) -> Result<Vec<ReconciliationItem>, StorageError> {
    let plan = stream_plan(filter, databases);
    let matcher = Matcher {
        filter,
        gates,
        now,
        live: true,
        proven: plan.tag.map(|(name, _)| name),
    };
    let mut items = Vec::new();
    let mut evaluated = 0;
    while position.index < plan.ranges.len() {
        let (low, high) = &plan.ranges[position.index];
        let range = encoding::resume_bounds(position.after.as_deref(), low, high);
        let mut reached_cap = false;
        for entry in plan.database.range(txn, &range)? {
            if items.len() >= STREAM_BATCH_ITEMS || evaluated >= STREAM_BATCH_KEYS {
                reached_cap = true;
                break;
            }
            let (key, _) = entry?;
            key_evaluated();
            // The cursor moves only onto a key this batch evaluated, because the next batch
            // resumes exclusively after it.
            position.after = Some(key.to_vec());
            evaluated += 1;
            let Some((created_at, event_id)) = key_candidate(plan.path, key)? else {
                return Err(encoding::invalid(
                    "events",
                    "a key without a timestamp and an event id".to_owned(),
                ));
            };
            if matcher.matches(txn, databases, &event_id)?.is_some() {
                items.push(ReconciliationItem {
                    created_at,
                    event_id,
                });
            }
        }
        if reached_cap {
            break;
        }
        position.index += 1;
        position.after = None;
    }
    Ok(items)
}

/// The `event_id` one `events_by_author` or `events_deleted` key ends with.
fn header_id(key: &[u8], start: usize, table: &'static str) -> Result<EventId, StorageError> {
    match key.get(start..) {
        Some(bytes) => encoding::event_id_from(bytes),
        None => Err(encoding::invalid(
            table,
            format!("a key of {} bytes", key.len()),
        )),
    }
}

/// The kind and event id an `events_by_author` key carries.
struct AuthorKeyHeader {
    kind: i32,
    event_id: EventId,
}

fn author_key_header(key: &[u8]) -> Result<AuthorKeyHeader, StorageError> {
    if key.len() != 76 {
        return Err(encoding::invalid(
            "events_by_author",
            format!("a key of {} bytes", key.len()),
        ));
    }
    Ok(AuthorKeyHeader {
        kind: encoding::i32_from_key(&key[32..36])?,
        event_id: encoding::event_id_from(&key[44..76])?,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    fn id(byte: u8) -> EventId {
        EventId::from_byte_array([byte; 32])
    }

    #[test]
    fn a_page_sorts_newest_first_with_the_smaller_id_first_on_a_tie() {
        let mut page = vec![(10, id(2)), (10, id(1)), (11, id(9))];
        sort_page(&mut page, true);
        assert_eq!(page, vec![(11, id(9)), (10, id(1)), (10, id(2))]);

        sort_page(&mut page, false);
        assert_eq!(page, vec![(10, id(1)), (10, id(2)), (11, id(9))]);
    }

    #[test]
    fn a_page_buffer_holds_at_most_twice_its_limit() {
        let mut page = Page::new(true);
        for step in 0u8..=100 {
            page.offer((i64::from(step), id(step)), 3);
            assert!(
                page.len() <= 6,
                "the buffer is cut back to the limit whenever it fills: {} entries",
                page.len()
            );
        }
        assert_eq!(page.finish(3).len(), 3);
    }

    #[test]
    fn only_a_hash_and_one_letter_is_a_tag_query() {
        assert_eq!(generic_tag_name("#e"), Some("e"));
        assert_eq!(generic_tag_name("#1"), None);
        assert_eq!(generic_tag_name("#ee"), None);
        assert_eq!(generic_tag_name("e"), None);
        assert_eq!(generic_tag_name("#"), None);
    }

    #[test]
    fn the_retention_whitelist_always_keeps_kind_62_and_deduplicates() {
        let whitelist = retention_kinds(Some(&[
            KindSelector::Single(Kind(1)),
            KindSelector::Single(Kind(1)),
        ]));
        assert_eq!(
            whitelist,
            vec![
                KindSelector::Single(Kind(1)),
                KindSelector::Single(Kind(62)),
            ]
        );
        assert!(whitelisted(62, &whitelist));
        assert!(whitelisted(1, &[KindSelector::Range([Kind(1), Kind(9)])]));
        assert!(!whitelisted(10, &[KindSelector::Range([Kind(1), Kind(9)])]));
    }

    #[test]
    fn a_geohash_wildcard_is_a_prefix_and_another_tag_treats_it_literally() {
        use nostream_core::Event;

        let event: Event = serde_json::from_value(serde_json::json!({
            "id": "0d684e8ec2431de586aa3cafbee2f6d308d19b28805e53deabcac3220e9136a5",
            "pubkey": "f43c1f9bff677b8f27b602725ea0ad51af221344f69a6b352a74991a4479bac3",
            "created_at": 1660407625i64,
            "kind": 1,
            "tags": [["g", "u4pruyd"], ["e", "other"]],
            "content": "",
            "sig": "ab".repeat(64)
        }))
        .expect("a wire event");
        let record = EventRecord::from_event(&event);

        let mut tags = BTreeMap::new();
        tags.insert("#g".to_owned(), vec!["u4pru*".to_owned()]);
        assert!(tag_criteria_match(&tags, &record, None));

        let mut tags = BTreeMap::new();
        tags.insert("#e".to_owned(), vec!["u4pru*".to_owned()]);
        assert!(!tag_criteria_match(&tags, &record, None));

        let mut tags = BTreeMap::new();
        tags.insert("#em".to_owned(), vec!["nothing".to_owned()]);
        assert!(tag_criteria_match(&tags, &record, None));
    }

    // -----------------------------------------------------------------------------------
    // The cost of a read, and the bound on what it holds.
    // -----------------------------------------------------------------------------------

    use crate::backend::LmdbEnv;
    use nostream_core::{Event, Signature};

    /// An open store on a temporary directory.
    fn store() -> (tempfile::TempDir, Env, Databases) {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let environment =
            LmdbEnv::open(directory.path().join("lmdb"), 8 << 20).expect("an environment");
        let env = environment.env().clone();
        let mut transaction = env.write_txn().expect("a write transaction");
        let databases = Databases::create(&env, &mut transaction).expect("the databases");
        transaction.commit().expect("the commit");
        (directory, env, databases)
    }

    /// A signed event of one author, carrying `tags`.
    fn signed(secret: u8, kind: u64, created_at: i64, tags: Vec<Vec<String>>) -> EventRecord {
        let mut wire = Event {
            id: EventId::from_byte_array([0; 32]),
            pubkey: Pubkey::from_byte_array([0; 32]),
            created_at,
            kind: Kind(kind),
            tags,
            content: format!("{secret}-{created_at}"),
            sig: Signature::from_byte_array([0; 64]),
        };
        nostream_core::crypto::sign_event(&[secret; 32], &mut wire).expect("the event signs");
        EventRecord::from_event(&wire)
    }

    /// Writes the events in one transaction, as `create_many` does.
    fn write(env: &Env, databases: &Databases, records: &[EventRecord]) {
        let mut transaction = env.write_txn().expect("a write transaction");
        create(&mut transaction, databases, records, Utc::now()).expect("the events store");
        transaction.commit().expect("the commit");
    }

    fn created(records: &[(i64, EventId)]) -> Vec<i64> {
        records.iter().map(|(created_at, _)| *created_at).collect()
    }

    #[test]
    fn a_limited_author_page_evaluates_only_the_keys_it_needs() {
        // The author index runs in kind order before `created_at`, so this page is answered by
        // the created-at index: it stops as soon as it is full instead of walking the author's
        // whole timeline (the round-2 shape evaluated every one of the 200).
        let _serial = probes::COUNTING.lock().expect("the counting lock");
        let (_directory, env, databases) = store();
        let records: Vec<EventRecord> = (1..=200)
            .map(|step| signed(7, 1, step, Vec::new()))
            .collect();
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let filter = Filter {
            authors: Some(vec![records[0].event.pubkey.to_string()]),
            limit: Some(2),
            ..Filter::default()
        };

        probes::reset();
        let page = branch(
            &transaction,
            &databases,
            &filter,
            &Gates::default(),
            0,
            false,
            page_limit(&filter),
        )
        .expect("the page");

        assert_eq!(created(&page), vec![200, 199]);
        assert!(
            probes::keys() <= 3,
            "a full page stops the walk: {} keys evaluated",
            probes::keys()
        );
    }

    #[test]
    fn a_limited_page_stops_at_the_limit_inside_one_author_and_kind() {
        // The `pubkey ‖ kind ‖ created_at` ordering the layout writes is what lets this page
        // stop; without it the walk reads every event of the author.
        let _serial = probes::COUNTING.lock().expect("the counting lock");
        let (_directory, env, databases) = store();
        let mut records: Vec<EventRecord> = (1..=200)
            .map(|step| signed(7, 1, step, Vec::new()))
            .collect();
        records.extend((1..=200).map(|step| signed(7, 2, step, Vec::new())));
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let filter = Filter {
            authors: Some(vec![records[0].event.pubkey.to_string()]),
            kinds: Some(vec![Kind(2)]),
            limit: Some(2),
            ..Filter::default()
        };

        probes::reset();
        let page = branch(
            &transaction,
            &databases,
            &filter,
            &Gates::default(),
            0,
            false,
            page_limit(&filter),
        )
        .expect("the page");

        assert_eq!(created(&page), vec![200, 199]);
        assert!(
            probes::keys() <= 3,
            "one range runs in time order and stops: {} keys evaluated",
            probes::keys()
        );
    }

    #[test]
    fn a_full_page_keeps_the_ties_at_its_boundary_timestamp() {
        // The created-at index reverses the whole key, so two rows at one instant are scanned
        // id-descending: a walk that stopped at the first would keep the larger id, where the
        // capture's comparator keeps the smaller (V6).
        let (_directory, env, databases) = store();
        let tag = |value: &str| vec![vec!["t".to_owned(), value.to_owned()]];
        let first = signed(9, 1, 500, tag("first"));
        let second = signed(9, 1, 500, tag("second"));
        let smallest = first.event.id.min(second.event.id);
        write(&env, &databases, &[first, second]);
        let transaction = env.read_txn().expect("a read transaction");
        let filter = Filter {
            kinds: Some(vec![Kind(1)]),
            limit: Some(1),
            ..Filter::default()
        };

        let page = branch(
            &transaction,
            &databases,
            &filter,
            &Gates::default(),
            0,
            false,
            page_limit(&filter),
        )
        .expect("the page");

        assert_eq!(
            page,
            vec![(500, smallest)],
            "the row tied at the boundary is still offered, and the smaller id wins"
        );
    }

    #[test]
    fn a_tag_page_checks_its_criterion_from_the_key_and_decodes_no_body() {
        let _serial = probes::COUNTING.lock().expect("the counting lock");
        let (_directory, env, databases) = store();
        let tag = |step: i64| {
            vec![
                vec!["t".to_owned(), "perfprobe".to_owned()],
                vec!["e".to_owned(), step.to_string()],
            ]
        };
        let records: Vec<EventRecord> = (1..=200)
            .map(|step| signed(7, 1, step, tag(step)))
            .collect();
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");

        let mut tags = BTreeMap::new();
        tags.insert("#t".to_owned(), vec!["perfprobe".to_owned()]);
        let filter = Filter {
            tags,
            limit: Some(2),
            ..Filter::default()
        };
        probes::reset();
        let page = branch(
            &transaction,
            &databases,
            &filter,
            &Gates::default(),
            0,
            false,
            page_limit(&filter),
        )
        .expect("the page");
        assert_eq!(created(&page), vec![200, 199]);
        assert_eq!(
            probes::decodes(),
            0,
            "the key carried the value the criterion sought"
        );
        assert!(
            probes::keys() <= 3,
            "the value's range runs in time order and stops: {} keys evaluated",
            probes::keys()
        );

        // A family the key cannot answer is decoded. `#a` sorts first, so the tag index is
        // sought by it and `#z` stays unproved.
        let (_directory, env, databases) = store();
        let both = |step: i64| {
            vec![
                vec!["a".to_owned(), "perfprobe".to_owned()],
                vec!["z".to_owned(), format!("other-{step}")],
            ]
        };
        let records: Vec<EventRecord> = (1..=200)
            .map(|step| signed(7, 1, step, both(step)))
            .collect();
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let mut tags = BTreeMap::new();
        tags.insert("#a".to_owned(), vec!["perfprobe".to_owned()]);
        tags.insert(
            "#z".to_owned(),
            vec!["other-200".to_owned(), "other-199".to_owned()],
        );
        let filter = Filter {
            tags,
            limit: Some(2),
            ..Filter::default()
        };
        probes::reset();
        let page = branch(
            &transaction,
            &databases,
            &filter,
            &Gates::default(),
            0,
            false,
            page_limit(&filter),
        )
        .expect("the page");
        assert_eq!(created(&page), vec![200, 199]);
        assert!(
            probes::decodes() >= 1,
            "the family the key cannot answer is decoded"
        );
    }

    #[test]
    fn a_wire_limit_cannot_grow_a_page_past_the_backend_bound() {
        assert_eq!(count_limit(10), 10);
        assert_eq!(count_limit(u64::MAX), MAX_PAGE_KEYS);

        let (_directory, env, databases) = store();
        let records: Vec<EventRecord> = (1..=MAX_PAGE_KEYS as i64 + 1)
            .map(|step| signed(11, 1, step, Vec::new()))
            .collect();
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let filter = Filter {
            kinds: Some(vec![Kind(1)]),
            limit: Some(u64::MAX),
            ..Filter::default()
        };

        let page = branch(
            &transaction,
            &databases,
            &filter,
            &Gates::default(),
            0,
            false,
            page_limit(&filter),
        )
        .expect("the page");

        assert_eq!(
            page.len(),
            MAX_PAGE_KEYS,
            "the page the backend materialises is its own bound, not the wire's"
        );
        assert_eq!(page[0].0, MAX_PAGE_KEYS as i64 + 1, "and it is the newest");
    }

    #[test]
    fn a_count_holds_no_matches_and_deduplicates_the_union() {
        let (_directory, env, databases) = store();
        let records = vec![
            signed(21, 1, 10, Vec::new()),
            signed(21, 1, 20, Vec::new()),
            signed(22, 1, 30, Vec::new()),
        ];
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let author = records[0].event.pubkey.to_string();

        let filters = vec![
            Filter {
                kinds: Some(vec![Kind(1)]),
                ..Filter::default()
            },
            Filter {
                authors: Some(vec![author.clone()]),
                ..Filter::default()
            },
        ];
        assert_eq!(
            count(&transaction, &databases, &filters, &Gates::default(), 0).expect("the count"),
            3,
            "the union of two overlapping filters counts each live id once"
        );

        // A limited branch contributes its own page, and the row a later filter adds is counted
        // only when the earlier page does not hold it.
        let filters = vec![
            Filter {
                kinds: Some(vec![Kind(1)]),
                limit: Some(2),
                ..Filter::default()
            },
            Filter {
                authors: Some(vec![author]),
                ..Filter::default()
            },
        ];
        assert_eq!(
            count(&transaction, &databases, &filters, &Gates::default(), 0).expect("the count"),
            3
        );
    }

    #[test]
    fn a_later_limited_page_does_not_recount_an_earlier_filter_s_rows() {
        let (_directory, env, databases) = store();
        let records = vec![
            signed(28, 1, 10, Vec::new()),
            signed(28, 1, 20, Vec::new()),
            signed(28, 1, 30, Vec::new()),
        ];
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let filters = vec![
            Filter {
                authors: Some(vec![records[0].event.pubkey.to_string()]),
                ..Filter::default()
            },
            Filter {
                kinds: Some(vec![Kind(1)]),
                limit: Some(2),
                ..Filter::default()
            },
        ];
        assert_eq!(
            count(&transaction, &databases, &filters, &Gates::default(), 0).expect("the count"),
            3,
            "the rows the earlier predicate counted are not counted again by the page"
        );
    }

    #[test]
    fn a_count_counts_a_row_once_when_two_tag_values_select_it() {
        let (_directory, env, databases) = store();
        let record = signed(
            23,
            1,
            10,
            vec![
                vec!["t".to_owned(), "a".to_owned()],
                vec!["t".to_owned(), "b".to_owned()],
            ],
        );
        write(&env, &databases, std::slice::from_ref(&record));
        let transaction = env.read_txn().expect("a read transaction");

        let mut tags = BTreeMap::new();
        tags.insert("#t".to_owned(), vec!["a".to_owned(), "b".to_owned()]);
        let filter = Filter {
            tags,
            ..Filter::default()
        };
        assert_eq!(
            count(
                &transaction,
                &databases,
                std::slice::from_ref(&filter),
                &Gates::default(),
                0
            )
            .expect("the count"),
            1,
            "one event under two matching values is one row"
        );
        let page = branch(
            &transaction,
            &databases,
            &filter,
            &Gates::default(),
            0,
            false,
            page_limit(&filter),
        )
        .expect("the page");
        assert_eq!(page.len(), 1);
    }

    #[test]
    fn a_reconciliation_scans_the_filter_own_index_when_one_ordered_range_answers_it() {
        let _serial = probes::COUNTING.lock().expect("the counting lock");
        let (_directory, env, databases) = store();
        let mut records: Vec<EventRecord> = (1..=300)
            .map(|step| signed(24, 1, step, Vec::new()))
            .collect();
        records.push(signed(25, 1, 400, Vec::new()));
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let filter = Filter {
            authors: Some(vec![records[300].event.pubkey.to_string()]),
            kinds: Some(vec![Kind(1)]),
            ..Filter::default()
        };

        probes::reset();
        let mut position = Position::new();
        let items = scan_batch(
            &transaction,
            &databases,
            &filter,
            &Gates::default(),
            0,
            &mut position,
        )
        .expect("the batch");

        assert_eq!(
            items,
            vec![ReconciliationItem {
                created_at: 400,
                event_id: records[300].event.id,
            }],
            "the filter's own index answers it"
        );
        assert!(
            probes::keys() <= 2,
            "the range the filter's own index narrows to is read, not the whole store: {} keys",
            probes::keys()
        );
    }

    #[test]
    fn a_reconciliation_batch_stops_at_its_key_cap_and_resumes() {
        let _serial = probes::COUNTING.lock().expect("the counting lock");
        let (_directory, env, databases) = store();
        let mut records: Vec<EventRecord> = (1..=1000)
            .map(|step| signed(26, 1, step, Vec::new()))
            .collect();
        records.push(signed(27, 4, 2_000, Vec::new()));
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let filter = Filter {
            kinds: Some(vec![Kind(4)]),
            ..Filter::default()
        };

        // One poll must not hold a read transaction for a whole range: it stops on the keys it
        // evaluated, not only on the rows it matched.
        probes::reset();
        let mut position = Position::new();
        let first = scan_batch(
            &transaction,
            &databases,
            &filter,
            &Gates::default(),
            0,
            &mut position,
        )
        .expect("the batch");
        assert!(first.is_empty(), "the only match is past the first batch");
        assert!(
            probes::keys() <= STREAM_BATCH_KEYS,
            "the batch stopped at the key cap: {} keys",
            probes::keys()
        );
        assert!(position.after.is_some(), "and it resumes after a key");

        // Resuming reaches the row, so the cap loses nothing.
        let mut found = Vec::new();
        for _ in 0..64 {
            found.extend(
                scan_batch(
                    &transaction,
                    &databases,
                    &filter,
                    &Gates::default(),
                    0,
                    &mut position,
                )
                .expect("the batch"),
            );
            if position.index == 0 && position.after.is_none() {
                break;
            }
        }
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].created_at, 2_000);
    }
}
