//! `EventRepository` against LMDB: the seven event databases, the write paths the capture's
//! `INSERT`/`ON CONFLICT` statements define, and the filter evaluation `sql.rs` composes.
//!
//! A read never holds a transaction across an await: a query materialises its page of
//! `(created_at, event_id)` keys inside one blocking closure, and the stream that returns the
//! rows re-seeks its cursor per batch (see [`ValuesStream`] and [`ReconciliationStream`]).

use std::cmp::Ordering;
use std::collections::{BTreeMap, BinaryHeap, HashSet};
use std::future::Future;
use std::net::IpAddr;
use std::ops::Bound;
use std::pin::Pin;
use std::task::{Context, Poll};

use chrono::{DateTime, Utc};
use futures_core::Stream;
use heed::types::Bytes;
use heed::{Database, Env, RoTxn, RwTxn};
use nostream_core::{Event, EventId, Filter, Kind, KindSelector, Pubkey};
use tokio::task::JoinHandle;

use super::encoding::{self, EventHeader};
use super::rows;
use super::{
    DEFAULT_FILTER_LIMIT, Databases, Gates, MAX_PAGE_KEYS, RETENTION_BATCH_SIZE,
    STREAM_BATCH_ITEMS, STREAM_BATCH_KEYS,
};
use crate::error::StorageError;
use crate::records::{distinct_replacements, replaces_fields};
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
    Ok(u64::from(upsert_one(txn, databases, record, now, false)?))
}

/// `upsert_many`: one row per replaceable address, then the same merge, in one write
/// transaction. The capture's bulk merge list omits `remote_address`, so a replacement keeps
/// the address the stored row had, which `postgres/events.rs`'s `upsert_many` does too.
pub(crate) fn upsert_many(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    records: &[EventRecord],
    now: DateTime<Utc>,
) -> Result<u64, StorageError> {
    // A batch may hold several versions of one replaceable address: the conflict key's owner
    // picks the winner, as Postgres does before its one statement, so the count is rows
    // written rather than records passed.
    let mut affected = 0;
    for record in distinct_replacements(records) {
        if upsert_one(txn, databases, record, now, true)? {
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
    keep_stored_address: bool,
) -> Result<bool, StorageError> {
    let kind = kind_of(record)?;
    let deduplication = record.deduplication();

    if databases
        .events
        .get(txn, record.event.id.as_bytes())?
        .is_some()
    {
        // A replaceable write conflicts on its address, not on its id: replaying one the store
        // already holds updates that row against itself and counts zero (`REPLACEABLE_MERGE`
        // never matches), and only an id naming another address violates
        // `events_event_id_unique`.
        if encoding::replaceable_kind(kind) {
            let pointer = encoding::replaceable_key(&record.event.pubkey, kind, &deduplication)?;
            if let Some(stored) = databases.replaceable.get(txn, &pointer)?
                && encoding::event_id_from(stored)? == record.event.id
            {
                return Ok(false);
            }
        }
        return Err(StorageError::DuplicateEvent);
    }

    let mut first_seen = None;
    let mut remote_address = record.remote_address;

    if encoding::replaceable_kind(kind) {
        let pointer = encoding::replaceable_key(&record.event.pubkey, kind, &deduplication)?;
        if let Some(stored) = databases.replaceable.get(txn, &pointer)? {
            let stored_id = encoding::event_id_from(stored)?;
            let Some(value) = databases.events.get(txn, stored_id.as_bytes())? else {
                // A pointer with no row: treat the incoming event as a plain insert.
                return write_upserted(
                    txn,
                    databases,
                    record,
                    now,
                    kind,
                    &deduplication,
                    None,
                    remote_address,
                );
            };
            let header = rows::event_header(value)?;
            if !replaces_fields(
                (record.event.created_at, record.event.id),
                (header.created_at, stored_id),
            ) {
                return Ok(false);
            }
            let stored_record = rows::decode_event(value)?;
            first_seen = stored_record.first_seen;
            if keep_stored_address {
                remote_address = stored_record.remote_address;
            }
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
        remote_address,
    )
}

#[allow(clippy::too_many_arguments)]
fn write_upserted(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    record: &EventRecord,
    now: DateTime<Utc>,
    kind: i32,
    deduplication: &[serde_json::Value],
    first_seen: Option<DateTime<Utc>>,
    remote_address: Option<IpAddr>,
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
        remote_address,
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

/// `delete_by_address`: the author's live rows of one addressable kind whose first `d` tag is
/// `identifier` and whose `created_at` is no later than `not_after`, soft-deleted.
///
/// The walk is the author-and-kind prefix of `events_by_author` — `pubkey ‖ kind ‖ created_at ‖
/// id` — so it is one index range rather than a filter page, and no page bound applies: a page
/// is what would put the address outside the search. The NIP-56 gate is a read's, not a
/// delete's, so a reported row is reachable here.
pub(crate) fn delete_by_address(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    pubkey: &Pubkey,
    kind: Kind,
    identifier: &str,
    not_after: i64,
    now: DateTime<Utc>,
) -> Result<u64, StorageError> {
    let kind_number = i32::try_from(kind.0).unwrap_or(i32::MAX);
    let mut prefix = Vec::with_capacity(36);
    prefix.extend_from_slice(pubkey.as_bytes());
    prefix.extend_from_slice(&encoding::i32_key(kind_number));

    let mut keys = Vec::new();
    for entry in databases.events_by_author.prefix_iter(txn, &prefix)? {
        let (key, _) = entry?;
        keys.push(key.to_vec());
    }

    let mut affected = 0;
    for key in keys {
        let header = author_key_header(&key)?;
        let Some(value) = databases.events.get(txn, header.event_id.as_bytes())? else {
            continue;
        };
        let record = rows::decode_event(value)?;
        if record.deleted_at.is_some()
            || record.event.created_at > not_after
            || kind_of(&record)? == REQUEST_TO_VANISH
            || d_identifier(&record.event) != identifier
        {
            continue;
        }
        soft_delete(txn, databases, &record, now)?;
        affected += 1;
    }
    Ok(affected)
}

/// The value of an event's first `d` tag, `""` when it carries none — the key the addressable
/// strategy deduplicates on (`parameterized_replaceable.rs:29-35`).
fn d_identifier(event: &Event) -> &str {
    event
        .tags
        .iter()
        .find(|tag| tag.len() >= 2 && tag[0] == "d")
        .map(|tag| tag[1].as_str())
        .unwrap_or_default()
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
        // A row whose expiry has not passed cannot be classified expired, and one that
        // qualifies by age is the created-at pass's business: the index's own order lets this
        // walk stop at `now` instead of reading every future expiry under the writer.
        let lower = encoding::i64_key(i64::MIN).to_vec();
        let mut upper = encoding::i64_key(now.saturating_sub(1)).to_vec();
        upper.extend([0xff; 32]);
        let range = encoding::bounds(&lower, &upper);
        for entry in databases.events_expiring.range(txn, &range)? {
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
    key_evaluated();
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

/// The work counters the cost tests assert on: a page's cost is its keys evaluated, its bodies
/// decoded — [`rows::probes`] counts every event-body decode, wherever it happens — and the
/// entries it sorted, and none of the three is visible in its result.
#[cfg(test)]
mod probes {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Serialises the tests that count work, so one cannot read another's numbers.
    pub(super) static COUNTING: Mutex<()> = Mutex::new(());

    static KEYS: AtomicUsize = AtomicUsize::new(0);
    static SORTED: AtomicUsize = AtomicUsize::new(0);

    pub(super) fn reset() {
        KEYS.store(0, Ordering::Relaxed);
        super::rows::probes::reset();
        SORTED.store(0, Ordering::Relaxed);
    }

    pub(super) fn key() {
        KEYS.fetch_add(1, Ordering::Relaxed);
    }

    pub(super) fn sorted(entries: usize) {
        SORTED.fetch_add(entries, Ordering::Relaxed);
    }

    pub(super) fn keys() -> usize {
        KEYS.load(Ordering::Relaxed)
    }

    pub(super) fn decodes() -> usize {
        super::rows::probes::decodes()
    }

    pub(super) fn sorted_entries() -> usize {
        SORTED.load(Ordering::Relaxed)
    }
}

/// The index one filter is answered from, the ranges within it, and what a key proves.
struct Plan<'a> {
    database: Database<Bytes, Bytes>,
    path: AccessPath,
    ranges: Vec<encoding::KeyRange<'a>>,
    /// Whether a range's own key order is the page's order, so a range stops at the page's own
    /// worst kept row instead of being walked whole.
    ordered: bool,
    /// The tag family the ranges were built from, with its criteria in the criteria's order —
    /// `tag_ranges` builds one range per criterion that fits a key, carrying that criterion. A
    /// key in these ranges has already proved that family, so the row's body is decoded only for
    /// the filter's other tag families, and a `tags` count holds one id per row its matcher
    /// accepts until the set is full, then reads a repeated key's body instead.
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
/// A count has no page, so it materialises no result set: each filter counts the rows it visits
/// and skips one the count already holds — a row of an earlier filter's page when that filter had
/// a limit (a page is at most [`MAX_PAGE_KEYS`] ids), or one its predicate matches when it had
/// none — which is the capture's `UNION`. A `tags` walk whose criteria can select one row twice
/// also holds the ids of the rows it matches, at most [`MAX_PAGE_KEYS`] of them; past that the
/// walk reads a row's body to tell an earlier key of the walk from a first one, so the set stops
/// growing and the total stays exact.
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

/// Counts the live rows one unlimited filter matches that the count does not already hold.
///
/// Every range is walked whole — a count has no page to stop at — and a row two of them select
/// is counted once, at the first key that selects it.
///
/// A `tags` key names one value of one row, so a row's keys within this walk are one per
/// matching value and per matching criterion. Whichever key the walk reaches first answers for
/// the row — ranges run in the criteria's order, so that is not necessarily the smallest of its
/// matching values — and the id it ends with answers the rest until the set holds
/// [`MAX_PAGE_KEYS`] of them.
fn count_matches(
    txn: &RoTxn<'_>,
    databases: &Databases,
    filter: &Filter,
    counted: &Counted<'_>,
    gates: &Gates,
    now: i64,
) -> Result<u64, StorageError> {
    count_matches_bounded(txn, databases, filter, counted, gates, now, MAX_PAGE_KEYS)
}

/// [`count_matches`], with the number of ids the walk may hold given explicitly, so a test can
/// compare the bounded walk against an unbounded one over one corpus.
fn count_matches_bounded(
    txn: &RoTxn<'_>,
    databases: &Databases,
    filter: &Filter,
    counted: &Counted<'_>,
    gates: &Gates,
    now: i64,
    cap: usize,
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
    // A single exact criterion names one key per row, so only a second criterion or a `#g`
    // prefix can walk one row twice, and only then is the id set paid for.
    //
    // shortcut: the set holds at most `MAX_PAGE_KEYS` ids; a repeated key past that reads the
    // row's body to ask whether an earlier key of this walk already answered for it, against a
    // slot per repeated row. Upgrade when a count past the cap must decode nothing, which needs
    // an index order that visits a row once.
    let mut counted_ids = HashSet::new();
    let dedupe = plan.tag.is_some_and(|(name, criteria)| {
        criteria.len() > 1
            || (name == "g" && criteria.iter().any(|criterion| criterion.ends_with('*')))
    });
    let mut total = 0;
    for range in &plan.ranges {
        let bounds = encoding::bounds(&range.low, &range.high);
        for entry in plan.database.range(txn, &bounds)? {
            let (key, _) = entry?;
            key_evaluated();
            let value = match plan.tag {
                Some((name, criteria)) => {
                    let value = encoding::tag_value(key)?;
                    if !tag_value_matches(name == "g", criteria, value) {
                        continue;
                    }
                    Some(value)
                }
                None => None,
            };
            let Some((_, id)) = candidate(txn, databases, plan.path, key)? else {
                continue;
            };
            // The set holds only rows this walk accepted, so a hit is a row it already counted:
            // no second test and no second decode.
            if dedupe && counted_ids.contains(&id) {
                continue;
            }
            if matcher.matches(txn, databases, &id)?.is_none() {
                continue;
            }
            if dedupe {
                // The verdict is the row's, not the key's, so a second key is decided the same
                // way and only a row this filter matches takes a slot in the set.
                if counted_ids.len() < cap {
                    counted_ids.insert(id);
                } else if let (Some((name, _)), Some((earlier, criterion))) = (plan.tag, range.tag)
                    && counted_earlier(txn, databases, name, earlier, criterion, value, &id)?
                {
                    continue;
                }
            }
            if !already_counted(txn, databases, counted, gates, now, &id)? {
                total += 1;
            }
        }
    }
    Ok(total)
}

/// Whether an earlier key of this walk already selects the row `id`, so counting it here would
/// count the row twice — the check a count makes once its id set is full.
///
/// Two ranges select one row when two criteria of the family match its tags; one range selects
/// it twice when a `#g` prefix matches two of its tags. The family's criteria before `criterion`
/// are passed in their order, so the first of them that matches answers for the row, and within
/// one prefix range the walk reaches the smallest matching value first.
///
/// This is the one place a count reads a row's body instead of its key: the key names a single
/// value, and the other values the row carries are only in the body.
fn counted_earlier(
    txn: &RoTxn<'_>,
    databases: &Databases,
    name: &str,
    earlier: &[String],
    criterion: &str,
    value: Option<&str>,
    id: &EventId,
) -> Result<bool, StorageError> {
    let is_geohash = name == "g";
    let prefix = criterion.strip_suffix('*').filter(|_| is_geohash);
    // A first exact criterion is the row's only key in this walk, so nothing earlier answers
    // for it and the body is not read.
    if earlier.is_empty() && prefix.is_none() {
        return Ok(false);
    }
    let Some(stored) = databases.events.get(txn, id.as_bytes())? else {
        return Ok(false);
    };
    let record = rows::decode_event(stored)?;
    if earlier.iter().any(|earlier_criterion| {
        record_has_tag(&record, name, std::slice::from_ref(earlier_criterion))
    }) {
        return Ok(true);
    }
    if prefix.is_none() {
        return Ok(false);
    }
    let Some(value) = value else {
        return Ok(false);
    };
    Ok(record.event.tags.iter().any(|tag| {
        matches!(
            (tag.first(), tag.get(1)),
            (Some(tag_name), Some(candidate))
                if tag_name == name
                    && !candidate.is_empty()
                    && matching_value(is_geohash, criterion, candidate).is_some()
                    && candidate.as_str() < value
        )
    }))
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
/// The resident set is the page, never the range, and the page is one accumulator across every
/// range the plan seeks — the top `limit` is global to them. A range whose key order is the
/// page's order stops once the page holds its own worst kept row: every row after it in that
/// range is past it, so a later range can no longer arm the stop at the first match it offers.
/// The comparison is strict, so every row tied at the boundary timestamp is still offered and
/// the tie breaks as the capture's does. The page is a heap rooted at that worst kept row, so
/// the boundary is one peek and an offer is one comparison until it beats the root.
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
    for range in &plan.ranges {
        let bounds = encoding::bounds(&range.low, &range.high);
        // A range starts at the boundary the page already holds: a range whose oldest row is
        // past it has nothing to add, and one that is not is walked from its own end.
        let mut boundary = if plan.ordered {
            page.boundary(limit)
        } else {
            None
        };
        for entry in scan(plan.database, txn, &bounds, plan.ordered && descending)? {
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
                if plan.ordered {
                    boundary = page.boundary(limit);
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

/// A page under construction: at most `limit` entries, held so the row the page would drop first
/// is the heap's root.
struct Page {
    kept: BinaryHeap<Kept>,
    seen: HashSet<EventId>,
    descending: bool,
}

impl Page {
    fn new(descending: bool) -> Self {
        Self {
            kept: BinaryHeap::new(),
            seen: HashSet::new(),
            descending,
        }
    }

    /// Keeps `key` if it can still be among the best `limit` the page has seen.
    fn offer(&mut self, key: (i64, EventId), limit: usize) {
        if limit == 0 || !self.seen.insert(key.1) {
            return;
        }
        if self.kept.len() < limit {
            self.kept.push(Kept {
                entry: key,
                descending: self.descending,
            });
            return;
        }
        let Some(worst) = self.kept.peek().map(|kept| kept.entry) else {
            return;
        };
        // A row the page would drop on its way in cannot be in it, and its id must leave `seen`
        // with it so that a later range may offer it again.
        if page_order(key, worst, self.descending) == Ordering::Less {
            if let Some(dropped) = self.kept.pop() {
                self.seen.remove(&dropped.entry.1);
            }
            self.kept.push(Kept {
                entry: key,
                descending: self.descending,
            });
        } else {
            self.seen.remove(&key.1);
        }
    }

    /// The timestamp of the worst row the page would keep, once it holds `limit` of them.
    ///
    /// A range that runs in the page's order cannot offer a row past it, so the walk stops
    /// there. That row is the heap's root, so the boundary costs one peek and the page is cut to
    /// the limit as it fills rather than when the boundary is read.
    fn boundary(&self, limit: usize) -> Option<i64> {
        if limit == 0 || self.kept.len() < limit {
            return None;
        }
        self.kept.peek().map(|worst| worst.entry.0)
    }

    /// The page in the capture's order, which is the one sort the whole page pays.
    fn finish(self, limit: usize) -> Vec<(i64, EventId)> {
        let mut page: Vec<(i64, EventId)> = self.kept.into_iter().map(|kept| kept.entry).collect();
        #[cfg(test)]
        probes::sorted(page.len());
        sort_page(&mut page, self.descending);
        page.truncate(limit);
        page
    }
}

/// A page entry, ordered by the page's own comparison: the row the page would drop first is the
/// greatest of them, so a max-heap keeps it at the root. Every entry of one heap shares its
/// direction.
#[derive(Clone, Copy)]
struct Kept {
    entry: (i64, EventId),
    descending: bool,
}

impl Ord for Kept {
    fn cmp(&self, other: &Self) -> Ordering {
        page_order(self.entry, other.entry, self.descending)
    }
}

impl PartialOrd for Kept {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Kept {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Kept {}

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

/// The capture's page order: newest first when `descending`, oldest first otherwise, the
/// smaller id first on a tie.
fn page_order(left: (i64, EventId), right: (i64, EventId), descending: bool) -> Ordering {
    if descending {
        right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1))
    } else {
        left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1))
    }
}

fn sort_page(page: &mut [(i64, EventId)], descending: bool) {
    page.sort_by(|left, right| page_order(*left, *right, descending));
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
            ranges: plain_ranges(encoding::hex_ranges(ids, 0)),
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
            && let Some(ranges) = author_kind_ranges(authors, kinds)
        {
            return Plan {
                database: databases.events_by_author,
                path: AccessPath::Authors,
                ranges: plain_ranges(ranges),
                // A range is `pubkey ‖ kind ‖ created_at ‖ event_id`, so it runs in time order
                // only when every criterion is a whole pubkey and every range one author and
                // kind.
                ordered: authors.iter().all(|criterion| criterion.len() == 64),
                tag: None,
            };
        }
        // Without kinds the author index runs in kind order before `created_at`, so a page
        // ordered by time has no early stop there, and the same index is given up when the
        // author × kind product is past `MAX_PAGE_KEYS`. The created-at index is the capture's
        // own path for this shape — ADR 0003 measured 5 508 rows discarded to return 500 for
        // the kind-only form — and its order *is* the page order, so the page stops when full.
        //
        // shortcut: a quiet author's page, and an author × kind filter composing more than
        // `MAX_PAGE_KEYS` ranges, read the created-at index with the criteria left to the
        // matcher; upgrade when statistics can choose between the two indexes, which is the
        // benchmark job's (ADR 0011).
        return Plan {
            database: databases.events_by_created_at,
            path: AccessPath::CreatedAt,
            ranges: plain_ranges(created_at_ranges(filter)),
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
        ranges: plain_ranges(created_at_ranges(filter)),
        ordered: true,
        tag: None,
    }
}

/// The ranges of a plan that reads an index a tag family did not build, so no criterion answers
/// for the keys in them.
fn plain_ranges<'a>(ranges: Vec<(Vec<u8>, Vec<u8>)>) -> Vec<encoding::KeyRange<'a>> {
    ranges.into_iter().map(encoding::KeyRange::plain).collect()
}

/// One range per author criterion on `events_by_author`, whose key is
/// `pubkey ‖ kind ‖ created_at ‖ event_id`. A whole pubkey composes one range per kind, so the
/// `pubkey ‖ kind ‖ created_at` ordering the layout writes lets a page for one author and one
/// kind stop as soon as it is full; a prefix criterion composes one range over its whole tail
/// instead, because its upper bound runs to the end of the pubkey field and a kind appended
/// after it is compared where no key writes one — every kind under the prefix would fall inside
/// every kind's range, and a count would visit those rows once per kind.
///
/// A criterion another already covers seeks no range of its own, and a repeated kind is one
/// range, so a count cannot visit a key twice.
///
/// `None` when the whole-pubkey ranges and kinds compose more than [`MAX_PAGE_KEYS`] ranges: a
/// filter can name a thousand authors and a thousand kinds, and their product is not bounded by
/// the page, so the caller answers it from the created-at index rather than materialising it.
fn author_kind_ranges(authors: &[String], kinds: &[Kind]) -> Option<Vec<(Vec<u8>, Vec<u8>)>> {
    let mut kinds: Vec<i32> = kinds
        .iter()
        .map(|kind| i32::try_from(kind.0).unwrap_or(i32::MAX))
        .collect();
    kinds.sort_unstable();
    kinds.dedup();

    let author_ranges = encoding::hex_ranges(authors, 0);
    let exact = author_ranges
        .iter()
        .filter(|(low, high)| low == high && low.len() == encoding::HEX_FIELD_LEN)
        .count();
    if exact.saturating_mul(kinds.len()) > MAX_PAGE_KEYS {
        return None;
    }
    let mut ranges =
        Vec::with_capacity(exact.saturating_mul(kinds.len()) + author_ranges.len() - exact);
    for (low, high) in author_ranges {
        if low == high && low.len() == encoding::HEX_FIELD_LEN {
            for kind in &kinds {
                let mut lower = low.clone();
                lower.extend_from_slice(&encoding::i32_key(*kind));
                let mut upper = lower.clone();
                upper.extend(std::iter::repeat_n(0xff, 8 + 32));
                ranges.push((lower, upper));
            }
        } else {
            let mut upper = high;
            upper.extend(std::iter::repeat_n(0xff, 4 + 8 + 32));
            ranges.push((low, upper));
        }
    }
    Some(encoding::disjoint(ranges))
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
        if self.carries_other_tag_criteria()
            && !tag_criteria_match(&self.filter.tags, &rows::decode_event(value)?, self.proven)
        {
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

/// The value a criterion selects, when it selects `value`: an exact equality, and only `#g`
/// honours a trailing `*` as a prefix. The one place the wildcard rule is written.
fn matching_value<'v>(is_geohash: bool, criterion: &str, value: &'v str) -> Option<&'v str> {
    let matches = match criterion.strip_suffix('*').filter(|_| is_geohash) {
        Some(prefix) => value.starts_with(prefix),
        None => value == criterion,
    };
    matches.then_some(value)
}

/// Whether a tag value satisfies one of a family's criteria.
///
/// `event_tags` holds no empty value, so an empty one satisfies nothing. The criterion a `tags`
/// key carries is checked here, from the key, and the same rule answers the decoded record.
fn tag_value_matches(is_geohash: bool, criteria: &[String], value: &str) -> bool {
    !value.is_empty()
        && criteria
            .iter()
            .any(|criterion| matching_value(is_geohash, criterion, value).is_some())
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
/// whichever comes first — with one read transaction per poll. An `ids` filter naming exact ids
/// is one batch of the request's own list, sorted in the poll that reads it; a prefix criterion
/// is a byte range and takes the bounded scan.
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
    /// Builds the stream for one filter, or refuses it as every other read does: a non-empty
    /// `search` with the NIP-50 gate on is [`StorageError::NotImplemented`], and a criterion
    /// family that is present but empty selects nothing (the capture's `1 = 0`).
    pub(crate) fn new(
        env: Env,
        databases: Databases,
        filter: &Filter,
        gates: Gates,
        now: i64,
    ) -> Result<Self, StorageError> {
        let admitted = admits(filter, &gates)?;
        let range_count = if admitted {
            stream_plan(filter, &databases).ranges.len()
        } else {
            0
        };
        Ok(Self {
            env,
            databases,
            filter: filter.clone(),
            gates,
            now,
            range_count,
            position: Position::new(),
            pending: None,
            buffer: Vec::new().into_iter(),
            finished: !admitted,
        })
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
/// The stream promises the pairs oldest first. An `ids` filter whose criteria are all exact is
/// answered from the filter's own ranges — one point per id, so the work is the request's id
/// list and not the store — and the batch sorts the pairs before it emits them, because an
/// `events` key runs in id order. A criterion is exact only when its range is a point: a prefix
/// is a byte range over the id field, and `""` is the whole store, so it is not the request's
/// list and takes the bounded scan instead. A filter the faster index narrows to one range that
/// runs in `created_at` order (`{authors: [a], kinds: [k]}` or one exact tag value) is scanned
/// there; anything else scans the created-at index, whose order *is* the promise.
///
/// shortcut: an author without kinds, a `#g` prefix and an id prefix narrow to no such range,
/// so their stream scans `events_by_created_at` and the criteria are left to the matcher — a
/// poll walks what the store holds rather than what the request names; upgrade when statistics
/// can choose the cheaper index, which is the benchmark job's (ADR 0011).
fn stream_plan<'a>(filter: &'a Filter, databases: &Databases) -> Plan<'a> {
    let chosen = plan(filter, databases);
    let exact_ids =
        chosen.path == AccessPath::Ids && chosen.ranges.iter().all(|range| range.low == range.high);
    if exact_ids || (chosen.ordered && chosen.ranges.len() == 1) {
        return chosen;
    }
    Plan {
        database: databases.events_by_created_at,
        path: AccessPath::CreatedAt,
        ranges: plain_ranges(created_at_ranges(filter)),
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
    if plan.path == AccessPath::Ids {
        return scan_ids(txn, databases, &matcher, &plan, position);
    }
    let mut items = Vec::new();
    let mut evaluated = 0;
    while position.index < plan.ranges.len() {
        let range = &plan.ranges[position.index];
        let bounds = encoding::resume_bounds(position.after.as_deref(), &range.low, &range.high);
        let mut reached_cap = false;
        for entry in plan.database.range(txn, &bounds)? {
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

/// The pairs an exact `ids` filter names, oldest first, with `position` moved past the id list.
///
/// The ranges are the request's own list, one point per id and already deduplicated, so the
/// work is the request rather than the store, and the list is read whole because an `events`
/// key runs in id order: the pairs are sorted before they are emitted instead of being sought
/// in time order. [`stream_plan`] keeps a prefix criterion away from here, because its range is
/// the id field's bytes rather than the request.
///
/// shortcut: the whole list is read in one poll and its pairs are held until the stream ends, so
/// the resident set is the request's own id list; upgrade when a request's list should be paged
/// too, which needs the pairs sorted before emission and therefore somewhere to spill them.
fn scan_ids(
    txn: &RoTxn<'_>,
    databases: &Databases,
    matcher: &Matcher<'_>,
    plan: &Plan<'_>,
    position: &mut Position,
) -> Result<Vec<ReconciliationItem>, StorageError> {
    let mut items = Vec::with_capacity(plan.ranges.len());
    for range in &plan.ranges {
        let bounds = encoding::bounds(&range.low, &range.high);
        for entry in plan.database.range(txn, &bounds)? {
            let (key, _) = entry?;
            key_evaluated();
            let Some((created_at, event_id)) = candidate(txn, databases, plan.path, key)? else {
                continue;
            };
            if matcher.matches(txn, databases, &event_id)?.is_some() {
                items.push(ReconciliationItem {
                    created_at,
                    event_id,
                });
            }
        }
    }
    items.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.event_id.cmp(&right.event_id))
    });
    position.index = plan.ranges.len();
    position.after = None;
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
    fn a_page_holds_at_most_its_limit() {
        let _serial = counting();
        let mut page = Page::new(true);
        for step in 0u8..=100 {
            page.offer((i64::from(step), id(step)), 3);
            assert!(
                page.kept.len() <= 3,
                "the page is its limit, never a buffer behind it: {} entries",
                page.kept.len()
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
        store_with_map(8 << 20)
    }

    /// An open store on a temporary directory, with room for a corpus past `MAX_PAGE_KEYS`.
    fn store_with_map(map_size: usize) -> (tempfile::TempDir, Env, Databases) {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let environment =
            LmdbEnv::open(directory.path().join("lmdb"), map_size).expect("an environment");
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

    /// A signed event of one author and its own body, for a corpus `signed` cannot build: more
    /// than its 256 authors, or several rows at one `created_at` under one author.
    fn signed_by(secret: [u8; 32], created_at: i64, content: &str) -> EventRecord {
        let mut wire = Event {
            id: EventId::from_byte_array([0; 32]),
            pubkey: Pubkey::from_byte_array([0; 32]),
            created_at,
            kind: Kind(1),
            tags: Vec::new(),
            content: content.to_owned(),
            sig: Signature::from_byte_array([0; 64]),
        };
        nostream_core::crypto::sign_event(&secret, &mut wire).expect("the event signs");
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
        let _serial = counting();
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
        let _serial = counting();
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
        let _serial = counting();
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
        let _serial = counting();
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
        let _serial = counting();
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

        // The relay decides whether a page was full from `MAX_PAGE_ROWS`, so the two constants
        // are the same number and cannot drift apart unnoticed.
        assert_eq!(
            MAX_PAGE_KEYS as u64,
            crate::MAX_PAGE_ROWS,
            "the relay's page bound is the backend's"
        );
    }

    #[test]
    fn a_count_holds_no_matches_and_deduplicates_the_union() {
        let _serial = counting();
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
        let _serial = counting();
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
        let _serial = counting();
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
        let _serial = counting();
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
        let _serial = counting();
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

    // -----------------------------------------------------------------------------------
    // Round 5: the composition bound and the shapes a stream narrows.
    // -----------------------------------------------------------------------------------

    #[test]
    fn an_author_and_kind_product_is_bounded_by_the_page() {
        // A hundred authors and a hundred kinds are a legal filter; the product is what a
        // request must not be able to turn into work this backend materialises.
        let authors: Vec<String> = (0..100u32).map(|step| format!("{step:064x}")).collect();
        let kinds: Vec<Kind> = (0..100u64).map(|step| Kind(10_000 + step)).collect();
        assert!(
            author_kind_ranges(&authors, &kinds).is_none(),
            "10000 ranges are not a plan"
        );

        // A product the page can hold still composes one range per pair.
        let kinds: Vec<Kind> = (0..49u64).map(|step| Kind(10_000 + step)).collect();
        assert_eq!(
            author_kind_ranges(&authors, &kinds)
                .expect("a bounded product")
                .len(),
            authors.len() * kinds.len()
        );

        // At the bound the author index is still the plan; one past it, it is not.
        let authors: Vec<String> = (0..MAX_PAGE_KEYS as u32)
            .map(|step| format!("{step:064x}"))
            .collect();
        assert_eq!(
            author_kind_ranges(&authors, &[Kind(1)])
                .expect("a product at the page bound")
                .len(),
            MAX_PAGE_KEYS
        );
        let authors: Vec<String> = (0..=MAX_PAGE_KEYS as u32)
            .map(|step| format!("{step:064x}"))
            .collect();
        assert!(
            author_kind_ranges(&authors, &[Kind(1)]).is_none(),
            "a product past the page bound falls back to the created-at index"
        );
    }

    #[test]
    fn a_prefix_author_counts_a_row_once_whatever_its_kind() {
        // A prefix author's bound runs to the end of the pubkey field, so a kind appended to
        // it does not narrow the range: the same key is in every kind's range.
        let _serial = counting();
        let (_directory, env, databases) = store();
        let records = vec![signed(30, 1, 10, Vec::new()), signed(30, 2, 20, Vec::new())];
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let prefix = records[0].event.pubkey.to_string()[..8].to_owned();
        let filter = Filter {
            authors: Some(vec![prefix]),
            kinds: Some(vec![Kind(1), Kind(2)]),
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
            2,
            "two rows, counted once each"
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
        assert_eq!(page.len(), 2, "and the page still returns both");
        let plan = plan(&filter, &databases);
        assert_eq!(
            plan.ranges.len(),
            1,
            "a prefix author seeks one range whatever the kinds"
        );
    }

    #[test]
    fn an_author_and_kind_product_past_the_page_is_answered_from_the_created_at_index() {
        let _serial = counting();
        let (_directory, env, databases) = store();
        let records = vec![
            signed(32, 10_000, 10, Vec::new()),
            signed(33, 10_001, 20, Vec::new()),
        ];
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");

        // A hundred authors and a hundred kinds compose ten thousand ranges, so the plan gives
        // up the author index; the rows are still the ones the criteria name.
        let mut authors: Vec<String> = (0..100u32).map(|step| format!("{step:064x}")).collect();
        authors[0] = records[0].event.pubkey.to_string();
        authors[1] = records[1].event.pubkey.to_string();
        let kinds: Vec<Kind> = (0..100u64).map(|step| Kind(10_000 + step)).collect();
        let filter = Filter {
            authors: Some(authors),
            kinds: Some(kinds),
            limit: Some(2),
            ..Filter::default()
        };

        let plan = plan(&filter, &databases);
        assert_eq!(plan.path, AccessPath::CreatedAt);
        assert_eq!(plan.ranges.len(), 1);
        assert_eq!(
            count(
                &transaction,
                &databases,
                std::slice::from_ref(&filter),
                &Gates::default(),
                0
            )
            .expect("the count"),
            2
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
        assert_eq!(
            created(&page),
            vec![20, 10],
            "newest first, the rows the filter names"
        );
    }

    #[test]
    fn a_reconciliation_reads_the_ids_the_filter_names_not_the_store() {
        let _serial = counting();
        let (_directory, env, databases) = store();
        let records: Vec<EventRecord> = (1..=300)
            .map(|step| signed(29, 1, step, Vec::new()))
            .collect();
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let filter = Filter {
            ids: Some(vec![
                records[250].event.id.to_string(),
                records[12].event.id.to_string(),
                records[199].event.id.to_string(),
            ]),
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
            vec![
                ReconciliationItem {
                    created_at: 13,
                    event_id: records[12].event.id,
                },
                ReconciliationItem {
                    created_at: 200,
                    event_id: records[199].event.id,
                },
                ReconciliationItem {
                    created_at: 251,
                    event_id: records[250].event.id,
                },
            ],
            "the request's ids, oldest first"
        );
        assert!(
            probes::keys() <= 3,
            "the id list bounds the work, not the store: {} keys evaluated",
            probes::keys()
        );
        assert_eq!(
            position.index,
            stream_plan(&filter, &databases).ranges.len(),
            "the whole list is one batch"
        );
    }

    #[test]
    fn a_quote_only_deduplication_value_stores_without_json_escaping() {
        let (_directory, env, databases) = store();
        let value = "\"".repeat(235);
        let record = signed(31, 30_023, 1, vec![vec!["d".to_owned(), value.clone()]])
            .with_deduplication(vec![serde_json::Value::String(value)]);

        let mut transaction = env.write_txn().expect("a write transaction");
        let affected = upsert(&mut transaction, &databases, &record, Utc::now())
            .expect("a d value that JSON text would escape twice still stores");
        transaction.commit().expect("the commit");
        assert_eq!(affected, 1);
    }

    // -----------------------------------------------------------------------------------
    // Round 11: one row per replaceable address in a batch.
    // -----------------------------------------------------------------------------------

    /// Two versions of one address reach the same batch in either order: the batch writes the
    /// newer row and counts one, which is what `upsert_many` promises its caller.
    #[test]
    fn a_batch_with_two_versions_of_one_address_writes_one_row() {
        let older = signed(7, 0, 1_700_000_000, Vec::new());
        let newer = signed(7, 0, 1_700_000_100, Vec::new());
        assert_eq!(older.event.pubkey, newer.event.pubkey);

        for batch in [
            vec![older.clone(), newer.clone()],
            vec![newer.clone(), older.clone()],
        ] {
            let (_directory, env, databases) = store();
            let mut transaction = env.write_txn().expect("a write transaction");
            let affected =
                upsert_many(&mut transaction, &databases, &batch, Utc::now()).expect("the batch");
            transaction.commit().expect("the commit");

            assert_eq!(affected, 1, "rows written, whatever the order");
            let transaction = env.read_txn().expect("a read transaction");
            assert!(
                databases
                    .events
                    .get(&transaction, older.event.id.as_bytes())
                    .expect("the store")
                    .is_none(),
                "the dropped version is not written"
            );
            assert!(
                databases
                    .events
                    .get(&transaction, newer.event.id.as_bytes())
                    .expect("the store")
                    .is_some(),
                "the newer version is the row the batch keeps"
            );
        }
    }

    // -----------------------------------------------------------------------------------
    // Round 12: the merge predicate reads the header and the pointer, never the body.
    // -----------------------------------------------------------------------------------

    /// A losing upsert decides from the stored value's header and the pointer's id, so it never
    /// decodes the body: a stored row whose body is unreadable still loses cleanly.
    #[test]
    fn a_losing_merge_reads_the_header_and_not_the_body() {
        let stored = signed(7, 0, 1_700_000_100, Vec::new());
        let older = signed(7, 0, 1_700_000_000, Vec::new());
        let (_directory, env, databases) = store();

        let mut transaction = env.write_txn().expect("a write transaction");
        upsert(&mut transaction, &databases, &stored, Utc::now()).expect("the stored version");
        transaction.commit().expect("the commit");

        // The value keeps its header — where the merge reads the stored `created_at` — and
        // loses its body.
        let mut transaction = env.write_txn().expect("a write transaction");
        let value = databases
            .events
            .get(&transaction, stored.event.id.as_bytes())
            .expect("the store")
            .expect("the stored row");
        let mut headless = value[..1 + encoding::EVENT_HEADER_LEN].to_vec();
        headless.extend_from_slice(b"{not json");
        databases
            .events
            .put(&mut transaction, stored.event.id.as_bytes(), &headless)
            .expect("the stored value");

        let affected = upsert(&mut transaction, &databases, &older, Utc::now())
            .expect("the older version loses from the header, never the body");
        transaction.commit().expect("the commit");

        assert_eq!(affected, 0, "the stored version is still the newer one");
    }

    // -----------------------------------------------------------------------------------
    // Round 12 rework: the replaceable write paths the PR's reviewer named.
    // -----------------------------------------------------------------------------------

    /// A replay of a replaceable event the store already holds updates that row against
    /// itself: the merge predicate never matches, so the count is zero — not the id collision
    /// `events_event_id_unique` reports for a kind with no conflict target.
    #[test]
    fn a_replayed_replaceable_event_counts_zero() {
        let record = signed(7, 0, 1_700_000_000, Vec::new());
        let (_directory, env, databases) = store();

        let mut transaction = env.write_txn().expect("a write transaction");
        assert_eq!(
            upsert(&mut transaction, &databases, &record, Utc::now()).expect("the first write"),
            1
        );
        assert_eq!(
            upsert(&mut transaction, &databases, &record, Utc::now()).expect("the replay"),
            0,
            "the replaceable conflict matches and the merge predicate does not"
        );
        transaction.commit().expect("the commit");

        let transaction = env.read_txn().expect("a read transaction");
        let value = databases
            .events
            .get(&transaction, record.event.id.as_bytes())
            .expect("the store")
            .expect("the row");
        assert_eq!(
            rows::decode_event(value).expect("the row").event.id,
            record.event.id,
            "the replay left the row in place"
        );
    }

    /// A kind with no conflict target has only the id to collide on, so a replay is still the
    /// capture's `rejected: event already exists`.
    #[test]
    fn a_duplicate_id_of_a_regular_kind_is_rejected() {
        let record = signed(8, 1, 1_700_000_000, Vec::new());
        let (_directory, env, databases) = store();

        let mut transaction = env.write_txn().expect("a write transaction");
        upsert(&mut transaction, &databases, &record, Utc::now()).expect("the first write");
        let error = upsert(&mut transaction, &databases, &record, Utc::now())
            .expect_err("the second insert of the same id");
        assert!(matches!(error, StorageError::DuplicateEvent));
    }

    /// The capture's bulk merge list omits `remote_address`, so a bulk replacement keeps the
    /// address the stored row had — even when the incoming record carries none — while the
    /// single-row merge writes the incoming address.
    #[test]
    fn a_bulk_replacement_keeps_the_stored_source_address() {
        let stored = signed(7, 0, 1_700_000_000, Vec::new())
            .with_remote_address(IpAddr::from([10, 0, 0, 1]));
        let newer = signed(7, 0, 1_700_000_100, Vec::new())
            .with_remote_address(IpAddr::from([10, 0, 0, 2]));
        let anonymous = signed(7, 0, 1_700_000_200, Vec::new());

        let (_directory, env, databases) = store();
        let mut transaction = env.write_txn().expect("a write transaction");
        upsert_many(
            &mut transaction,
            &databases,
            std::slice::from_ref(&stored),
            Utc::now(),
        )
        .expect("the stored version");
        upsert_many(
            &mut transaction,
            &databases,
            std::slice::from_ref(&newer),
            Utc::now(),
        )
        .expect("the bulk replacement");
        upsert_many(
            &mut transaction,
            &databases,
            std::slice::from_ref(&anonymous),
            Utc::now(),
        )
        .expect("a bulk replacement with no address");
        transaction.commit().expect("the commit");

        let transaction = env.read_txn().expect("a read transaction");
        let value = databases
            .events
            .get(&transaction, anonymous.event.id.as_bytes())
            .expect("the store")
            .expect("the last row");
        let row = rows::decode_event(value).expect("the row");
        assert_eq!(
            row.remote_address,
            Some(IpAddr::from([10, 0, 0, 1])),
            "the bulk merge preserves the address across both replacements"
        );

        let (_directory, env, databases) = store();
        let mut transaction = env.write_txn().expect("a write transaction");
        upsert(&mut transaction, &databases, &stored, Utc::now()).expect("the stored version");
        upsert(&mut transaction, &databases, &newer, Utc::now()).expect("the single replacement");
        transaction.commit().expect("the commit");

        let transaction = env.read_txn().expect("a read transaction");
        let value = databases
            .events
            .get(&transaction, newer.event.id.as_bytes())
            .expect("the store")
            .expect("the replacement");
        assert_eq!(
            rows::decode_event(value).expect("the row").remote_address,
            Some(IpAddr::from([10, 0, 0, 2])),
            "the single-row merge writes the incoming address"
        );
    }

    /// A count walks keys, not bodies: the id a tag key ends with says whether the row is
    /// already counted, so a wildcard count decodes nothing however many values it matches.
    #[test]
    fn a_wildcard_count_decodes_no_body() {
        let _serial = counting();
        let (_directory, env, databases) = store();
        let record = signed(
            7,
            1,
            1_700_000_000,
            vec![
                vec!["g".to_owned(), "u4a".to_owned()],
                vec!["g".to_owned(), "u4b".to_owned()],
            ],
        );
        write(&env, &databases, &[record]);
        let transaction = env.read_txn().expect("a read transaction");
        let mut tags = BTreeMap::new();
        tags.insert("#g".to_owned(), vec!["u4*".to_owned()]);
        let filter = Filter {
            tags,
            ..Filter::default()
        };

        probes::reset();
        assert_eq!(
            count(
                &transaction,
                &databases,
                std::slice::from_ref(&filter),
                &Gates::default(),
                0
            )
            .expect("the count"),
            1
        );
        assert_eq!(probes::decodes(), 0, "a count decodes no body");
        assert_eq!(probes::keys(), 2, "both keys the prefix selects are read");
    }

    /// A criterion too long to seek selects nothing, so a row carrying only later criteria is
    /// still counted — once, at the first criterion's range that selects it.
    #[test]
    fn a_dropped_criterion_does_not_count_a_row_twice() {
        let _serial = counting();
        let (_directory, env, databases) = store();
        let record = signed(
            7,
            1,
            1_700_000_000,
            vec![
                vec!["t".to_owned(), "a".to_owned()],
                vec!["t".to_owned(), "b".to_owned()],
            ],
        );
        write(&env, &databases, &[record]);
        let transaction = env.read_txn().expect("a read transaction");
        let mut tags = BTreeMap::new();
        tags.insert(
            "#t".to_owned(),
            vec!["x".repeat(500), "a".to_owned(), "b".to_owned()],
        );
        let filter = Filter {
            tags,
            ..Filter::default()
        };

        assert_eq!(
            plan(&filter, &databases).ranges.len(),
            2,
            "the oversized criterion seeks nothing"
        );
        probes::reset();
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
            "the row carries both values and is one row"
        );
        assert_eq!(
            probes::decodes(),
            0,
            "two criteria are deduplicated by the id, not the body"
        );
    }

    /// A count's total does not depend on how many ids its walk may hold: past the cap a
    /// repeated key reads the row's body to tell an earlier key from a first one, and this runs
    /// that walk and the one the set alone answers over one corpus.
    #[test]
    fn a_count_past_its_id_cap_totals_what_the_unbounded_walk_totals() {
        let _serial = counting();
        let (_directory, env, databases) = store_with_map(32 << 20);
        // Past `MAX_PAGE_KEYS`, so every filter below crosses the cap: the first 5 000 ids fill
        // the set and the rest of the walk takes the body check.
        let rows = MAX_PAGE_KEYS as i64 + 200;
        let records: Vec<EventRecord> = (0..rows)
            .map(|step| {
                signed(
                    (step % 200 + 1) as u8,
                    1,
                    step,
                    vec![
                        vec!["t".to_owned(), "a".to_owned()],
                        vec!["t".to_owned(), "b".to_owned()],
                        vec!["g".to_owned(), "u4a".to_owned()],
                        vec!["g".to_owned(), "u4b".to_owned()],
                    ],
                )
            })
            .collect();
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let tags = |families: &[(&str, &[&str])]| -> BTreeMap<String, Vec<String>> {
            families
                .iter()
                .map(|(key, criteria)| {
                    (
                        (*key).to_owned(),
                        criteria.iter().map(|value| (*value).to_owned()).collect(),
                    )
                })
                .collect()
        };
        let cases = [
            ("two criteria", tags(&[("#t", &["a", "b"])])),
            ("a repeated criterion", tags(&[("#t", &["a", "a"])])),
            ("a prefix over two values", tags(&[("#g", &["u4*"])])),
            (
                "a prefix and an exact value it covers",
                tags(&[("#g", &["u4*", "u4b"])]),
            ),
            (
                "a value only the later criterion names",
                tags(&[("#t", &["zz", "a"])]),
            ),
        ];
        for (what, tags) in cases {
            let filter = Filter {
                tags,
                ..Filter::default()
            };
            let counted = Counted::default();
            probes::reset();
            let capped = count_matches_bounded(
                &transaction,
                &databases,
                &filter,
                &counted,
                &Gates::default(),
                0,
                MAX_PAGE_KEYS,
            )
            .expect("the bounded count");
            let decodes = probes::decodes();
            probes::reset();
            let uncapped = count_matches_bounded(
                &transaction,
                &databases,
                &filter,
                &counted,
                &Gates::default(),
                0,
                usize::MAX,
            )
            .expect("the unbounded count");
            assert_eq!(
                capped, uncapped,
                "{what}: the cap changes how, not how many"
            );
            assert_eq!(capped, rows as u64, "{what}: every row matches");
            assert_eq!(probes::decodes(), 0, "{what}: the set decodes no body");
            assert!(
                decodes > 0,
                "{what}: the walk past the cap really took the body check"
            );
            probes::reset();
            assert_eq!(
                count(
                    &transaction,
                    &databases,
                    std::slice::from_ref(&filter),
                    &Gates::default(),
                    0
                )
                .expect("the count"),
                capped,
                "{what}: the count's own path agrees with the bounded walk"
            );
        }
    }

    /// The expiry pass reads the index no further than the last expired row: a future expiry is
    /// not a candidate, and a row that qualifies only by age is the created-at pass's business.
    #[test]
    fn the_expiry_pass_stops_at_the_last_expired_row() {
        let _serial = counting();
        let (_directory, env, databases) = store();
        let now = 1_700_000_000;
        let mut records = vec![signed(7, 1, now - 100, Vec::new()).with_expires_at(now - 50)];
        records.extend((0..500).map(|step| {
            signed_by([9; 32], now - 10, &format!("future-{step}"))
                .with_expires_at(now + 1_000 + step)
        }));
        write(&env, &databases, &records);

        let options = EventRetentionOptions {
            max_days: Some(1),
            kind_whitelist: None,
            pubkey_whitelist: None,
        };
        probes::reset();
        let mut transaction = env.write_txn().expect("a write transaction");
        let counts = delete_expired_and_retained(&mut transaction, &databases, &options, now)
            .expect("the pass");
        transaction.commit().expect("the commit");

        assert_eq!(counts.expired, 1);
        assert_eq!(counts.retained, 0, "ten seconds old is not over retention");
        assert_eq!(
            probes::keys(),
            1,
            "the pass visits the expired row and stops at `now`"
        );
    }
    // -----------------------------------------------------------------------------------
    // Round 6: the page across every range a plan seeks, and the id stream's two shapes.
    // -----------------------------------------------------------------------------------

    /// Serialises a test that counts work against every other one, so a clean run means what
    /// it says. A test that panicked while holding the lock poisons it, and a poisoned lock
    /// must not redden the tests that follow.
    fn counting() -> std::sync::MutexGuard<'static, ()> {
        probes::COUNTING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The page a filter must return, built from the store itself rather than from an index:
    /// every row the matcher accepts, in the capture's order, cut to the filter's page.
    fn reference_page(
        txn: &RoTxn<'_>,
        databases: &Databases,
        filter: &Filter,
    ) -> Vec<(i64, EventId)> {
        let matcher = Matcher {
            filter,
            gates: &Gates::default(),
            now: 0,
            live: false,
            proven: None,
        };
        let mut page = Vec::new();
        for entry in databases.events.iter(txn).expect("the store") {
            let (key, _) = entry.expect("a row");
            let id = encoding::event_id_from(key).expect("an event id");
            if let Some(header) = matcher.matches(txn, databases, &id).expect("a match") {
                page.push((header.created_at, id));
            }
        }
        sort_page(&mut page, filter.limit.is_some());
        page.truncate(page_limit(filter));
        page
    }

    /// The items a reconciliation must yield for a filter, built from the store itself: every
    /// row the matcher accepts, oldest first.
    fn reference_items(
        txn: &RoTxn<'_>,
        databases: &Databases,
        filter: &Filter,
    ) -> Vec<ReconciliationItem> {
        let matcher = Matcher {
            filter,
            gates: &Gates::default(),
            now: 0,
            live: true,
            proven: None,
        };
        let mut items = Vec::new();
        for entry in databases.events.iter(txn).expect("the store") {
            let (key, _) = entry.expect("a row");
            let id = encoding::event_id_from(key).expect("an event id");
            if let Some(header) = matcher.matches(txn, databases, &id).expect("a match") {
                items.push(ReconciliationItem {
                    created_at: header.created_at,
                    event_id: id,
                });
            }
        }
        items.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.event_id.cmp(&right.event_id))
        });
        items
    }

    /// The page `branch` returns, the store's own answer, and the count of the same filter all
    /// agree.
    fn assert_page_agrees(
        txn: &RoTxn<'_>,
        databases: &Databases,
        filter: &Filter,
        expected: &[i64],
        what: &str,
    ) {
        let page = branch(
            txn,
            databases,
            filter,
            &Gates::default(),
            0,
            false,
            page_limit(filter),
        )
        .expect("the page");
        assert_eq!(
            created(&page),
            expected,
            "{what}: the page is the capture's newest rows"
        );
        assert_eq!(
            page,
            reference_page(txn, databases, filter),
            "{what}: the page is the store's own answer"
        );
        assert_eq!(
            count(
                txn,
                databases,
                std::slice::from_ref(filter),
                &Gates::default(),
                0
            )
            .expect("the count"),
            page.len() as u64,
            "{what}: the page and the count of the same filter agree"
        );
    }

    /// The page `branch` returns over a filter whose plan seeks `ranges` time-ordered ranges,
    /// with the entries it sorted counted: the accumulator holds the page as a heap rooted at
    /// its worst kept row, so the only sort is the one in `finish` and the request sorts its own
    /// `limit` rows however many ranges it walks.
    fn assert_page_sorts_once(
        txn: &RoTxn<'_>,
        databases: &Databases,
        filter: &Filter,
        ranges: usize,
    ) -> Vec<(i64, EventId)> {
        let plan = plan(filter, databases);
        assert_eq!(plan.ranges.len(), ranges, "the plan seeks its own ranges");
        assert!(plan.ordered, "and a range's key order is the page's");
        probes::reset();
        let page = branch(
            txn,
            databases,
            filter,
            &Gates::default(),
            0,
            false,
            page_limit(filter),
        )
        .expect("the page");
        assert_eq!(
            probes::sorted_entries(),
            page.len(),
            "one page sorts its own rows once, whatever the number of ranges"
        );
        assert_eq!(
            probes::sorted_entries(),
            page_limit(filter),
            "and a full page is exactly the limit"
        );
        assert_eq!(
            page,
            reference_page(txn, databases, filter),
            "the page is the store's own answer"
        );
        page
    }

    #[test]
    fn a_page_sorts_its_own_limit_once_however_many_ranges_it_seeks() {
        // The boundary is the page's own worst kept row and the page is a heap rooted at it, so
        // an offer costs a comparison with that root and the one sort happens in `finish`.
        // Computing the boundary by sorting the page instead costs `limit` entries sorted on
        // every accepted offer: the 5 000 whole-pubkey ranges built here sorted 2 820 637
        // entries at the 500 default, and the 5 000 rows tied at one timestamp sorted 2 255 500.
        // (Round 6's performance review quotes 2 828 653 for a different corpus — 5 001 events
        // with one quiet author — so the two figures are not the same measurement.)
        let _serial = counting();

        // One kind-1 event for each of 5 000 authors: one range per author, one key each.
        let (_directory, env, databases) = store();
        let records: Vec<EventRecord> = (0..MAX_PAGE_KEYS as u32)
            .map(|author| {
                let mut secret = [0u8; 32];
                secret[..4].copy_from_slice(&author.to_be_bytes());
                secret[31] = 1;
                signed_by(secret, i64::from(author), &author.to_string())
            })
            .collect();
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let filter = Filter {
            authors: Some(
                records
                    .iter()
                    .map(|record| record.event.pubkey.to_string())
                    .collect(),
            ),
            kinds: Some(vec![Kind(1)]),
            limit: Some(DEFAULT_FILTER_LIMIT),
            ..Filter::default()
        };
        let page = assert_page_sorts_once(&transaction, &databases, &filter, MAX_PAGE_KEYS);
        assert_eq!(
            created(&page),
            (MAX_PAGE_KEYS as i64 - DEFAULT_FILTER_LIMIT as i64..MAX_PAGE_KEYS as i64)
                .rev()
                .collect::<Vec<i64>>(),
            "the page is the newest `limit` authors, newest first"
        );

        // One author's 5 000 rows at one timestamp: one range, and every row past the limit is
        // a match the accumulator considers.
        let (_directory, env, databases) = store();
        let records: Vec<EventRecord> = (0..MAX_PAGE_KEYS as u32)
            .map(|step| signed_by([9; 32], 5_000, &step.to_string()))
            .collect();
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let filter = Filter {
            authors: Some(vec![records[0].event.pubkey.to_string()]),
            kinds: Some(vec![Kind(1)]),
            limit: Some(DEFAULT_FILTER_LIMIT),
            ..Filter::default()
        };
        let page = assert_page_sorts_once(&transaction, &databases, &filter, 1);
        assert!(
            created(&page).iter().all(|created_at| *created_at == 5_000),
            "every row the page holds is at the boundary timestamp"
        );
        assert!(
            page.windows(2).all(|pair| pair[0].1 < pair[1].1),
            "so the tie is broken by the smaller id"
        );
    }

    #[test]
    fn a_limited_page_over_several_time_ordered_ranges_holds_the_global_newest_rows() {
        // A page is one accumulator across every range the plan seeks: an author × kind
        // filter seeks one range per kind, and the top `limit` is global to them, so a later
        // range may not stop at the first row it offers.
        let _serial = counting();
        let (_directory, env, databases) = store();
        let records: Vec<EventRecord> = (1..=40)
            .map(|step: i64| signed(7, (step % 3) as u64 + 1, step * 10, Vec::new()))
            .collect();
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let author = records[0].event.pubkey.to_string();
        let prefix = author[..8].to_owned();
        let two_kinds = &[390, 380, 360, 350, 330];
        let every_kind = &[400, 390, 380, 370, 360];

        let cases: Vec<(&str, Filter, AccessPath, usize, &[i64])> = vec![
            (
                "one author and two kinds",
                Filter {
                    authors: Some(vec![author.clone()]),
                    kinds: Some(vec![Kind(1), Kind(3)]),
                    limit: Some(5),
                    ..Filter::default()
                },
                AccessPath::Authors,
                2,
                two_kinds,
            ),
            (
                "the same kinds in the other order",
                Filter {
                    authors: Some(vec![author.clone()]),
                    kinds: Some(vec![Kind(3), Kind(1)]),
                    limit: Some(5),
                    ..Filter::default()
                },
                AccessPath::Authors,
                2,
                two_kinds,
            ),
            (
                "two kinds without an author",
                Filter {
                    kinds: Some(vec![Kind(1), Kind(3)]),
                    limit: Some(5),
                    ..Filter::default()
                },
                AccessPath::CreatedAt,
                1,
                two_kinds,
            ),
            (
                "one author without kinds",
                Filter {
                    authors: Some(vec![author]),
                    limit: Some(5),
                    ..Filter::default()
                },
                AccessPath::CreatedAt,
                1,
                every_kind,
            ),
            (
                "a prefix author and two kinds",
                Filter {
                    authors: Some(vec![prefix]),
                    kinds: Some(vec![Kind(1), Kind(3)]),
                    limit: Some(5),
                    ..Filter::default()
                },
                AccessPath::Authors,
                1,
                two_kinds,
            ),
        ];
        for (what, filter, path, ranges, expected) in cases {
            let plan = plan(&filter, &databases);
            assert_eq!(
                (plan.path, plan.ranges.len()),
                (path, ranges),
                "{what}: the plan"
            );
            assert_page_agrees(&transaction, &databases, &filter, expected, what);
        }
    }

    #[test]
    fn a_tie_at_the_boundary_timestamp_is_decided_by_a_later_range() {
        // A row tied with the page's worst kept row is not past the boundary, so a later range
        // still offers it and the smaller id wins the tie. Stopping at the boundary instead of
        // after it would keep the earlier range's row.
        let _serial = counting();
        let (_directory, env, databases) = store();
        let mut records = vec![
            signed(11, 1, 200, Vec::new()),
            signed(11, 3, 200, Vec::new()),
            signed(11, 1, 190, Vec::new()),
            signed(11, 3, 190, Vec::new()),
        ];
        // The tie breaks on the id, so the pair at the boundary timestamp is chosen for it: the
        // row of the kind whose range runs second carries the smaller id.
        let (first, second) = (0..64)
            .map(|step| {
                (
                    signed(11, 1, 180, vec![vec!["x".to_owned(), format!("a{step}")]]),
                    signed(11, 3, 180, vec![vec!["x".to_owned(), format!("b{step}")]]),
                )
            })
            .find(|(first, second)| second.event.id < first.event.id)
            .expect("a pair whose later range carries the smaller id");
        records.push(first);
        let tied = second.event.id;
        records.push(second);
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let filter = Filter {
            authors: Some(vec![records[0].event.pubkey.to_string()]),
            kinds: Some(vec![Kind(1), Kind(3)]),
            limit: Some(5),
            ..Filter::default()
        };
        let chosen = plan(&filter, &databases);
        assert_eq!(
            (chosen.path, chosen.ranges.len()),
            (AccessPath::Authors, 2),
            "one range per kind, the first kind's before the second's"
        );

        assert_page_agrees(
            &transaction,
            &databases,
            &filter,
            &[200, 200, 190, 190, 180],
            "a tie at the boundary",
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
        assert_eq!(
            page.last().map(|(_, id)| *id),
            Some(tied),
            "the tie goes to the smaller id, from the range that runs later"
        );
    }

    #[test]
    fn a_limited_page_over_two_tag_values_does_not_depend_on_the_criteria_s_order() {
        // One criterion is one range on `tags`, and each range runs in `created_at` order
        // under its own value, so a page over two values is the global top `limit` of both.
        let _serial = counting();
        let (_directory, env, databases) = store();
        let records: Vec<EventRecord> = (1..=40)
            .map(|step| {
                let mut tags = vec![vec!["t".to_owned(), "a".to_owned()]];
                if step % 3 != 1 {
                    tags.push(vec!["t".to_owned(), "b".to_owned()]);
                }
                signed(8, 1, step * 10, tags)
            })
            .collect();
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let author = records[0].event.pubkey.to_string();
        let expected = [400, 390, 380, 370, 360];

        for criteria in [
            vec!["a".to_owned(), "b".to_owned()],
            vec!["b".to_owned(), "a".to_owned()],
        ] {
            let mut tags = BTreeMap::new();
            tags.insert("#t".to_owned(), criteria.clone());
            let filter = Filter {
                tags: tags.clone(),
                limit: Some(5),
                ..Filter::default()
            };
            assert_eq!(
                plan(&filter, &databases).ranges.len(),
                2,
                "one range per value"
            );
            assert_page_agrees(
                &transaction,
                &databases,
                &filter,
                &expected,
                "two tag values",
            );

            // A criterion of another family is the matcher's, over the same two ranges.
            let filter = Filter {
                kinds: Some(vec![Kind(1)]),
                tags,
                limit: Some(5),
                ..Filter::default()
            };
            assert_page_agrees(
                &transaction,
                &databases,
                &filter,
                &expected,
                "a kind and two tag values",
            );

            // An author as well makes the author index the plan; the page is the same one.
            let mut tags = BTreeMap::new();
            tags.insert("#t".to_owned(), criteria);
            let filter = Filter {
                authors: Some(vec![author.clone()]),
                kinds: Some(vec![Kind(1)]),
                tags,
                limit: Some(5),
                ..Filter::default()
            };
            assert_page_agrees(
                &transaction,
                &databases,
                &filter,
                &expected,
                "an author, a kind and two tag values",
            );
        }

        // A single value's own page, so the two-value case is not "everything, in any order".
        let mut tags = BTreeMap::new();
        tags.insert("#t".to_owned(), vec!["b".to_owned()]);
        let filter = Filter {
            tags,
            limit: Some(5),
            ..Filter::default()
        };
        assert_page_agrees(
            &transaction,
            &databases,
            &filter,
            &[390, 380, 360, 350, 330],
            "one tag value",
        );
    }

    #[test]
    fn an_unlimited_page_over_two_tag_values_is_the_global_oldest_rows() {
        // Without a limit the page keeps the oldest rows, so the same accumulator is read from
        // the other end: a later range whose oldest row is older than the page's worst kept row
        // must be walked, not stopped at its first match.
        let _serial = counting();
        let (_directory, env, databases) = store();
        let records: Vec<EventRecord> = (1..=1200)
            .map(|step: i64| {
                let value = if step % 3 == 0 { "b" } else { "a" };
                signed(36, 1, step, vec![vec!["t".to_owned(), value.to_owned()]])
            })
            .collect();
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let oldest: Vec<i64> = (1..=500).collect();

        for criteria in [
            vec!["a".to_owned(), "b".to_owned()],
            vec!["b".to_owned(), "a".to_owned()],
        ] {
            let mut tags = BTreeMap::new();
            tags.insert("#t".to_owned(), criteria);
            let filter = Filter {
                tags,
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
                created(&page),
                oldest,
                "the page is the 500 oldest rows the values select, in either order"
            );
            assert_eq!(
                page,
                reference_page(&transaction, &databases, &filter),
                "and it is the store's own answer"
            );
        }
    }

    #[test]
    fn the_author_index_and_the_created_at_fallback_return_the_same_page() {
        // A filter composing more than `MAX_PAGE_KEYS` author × kind ranges is answered from
        // the created-at index instead, and both plans must return the same page.
        let _serial = counting();
        let (_directory, env, databases) = store();
        let records: Vec<EventRecord> = (1..=40)
            .map(|step: i64| signed(9, (step % 3) as u64 + 1, step * 10, Vec::new()))
            .collect();
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let expected = [390, 380, 360, 350, 330];
        let composed = |fakes: u32| -> Vec<String> {
            std::iter::once(records[0].event.pubkey.to_string())
                .chain((0..fakes).map(|step| format!("{:064x}", 0x1000 + step)))
                .collect()
        };

        let at_bound = Filter {
            authors: Some(composed(MAX_PAGE_KEYS as u32 / 2 - 1)),
            kinds: Some(vec![Kind(1), Kind(3)]),
            limit: Some(5),
            ..Filter::default()
        };
        let chosen = plan(&at_bound, &databases);
        assert_eq!(
            (chosen.path, chosen.ranges.len()),
            (AccessPath::Authors, MAX_PAGE_KEYS)
        );
        assert_page_agrees(
            &transaction,
            &databases,
            &at_bound,
            &expected,
            "at the page bound",
        );
        let index_page = branch(
            &transaction,
            &databases,
            &at_bound,
            &Gates::default(),
            0,
            false,
            page_limit(&at_bound),
        )
        .expect("the page");

        let past_bound = Filter {
            authors: Some(composed(MAX_PAGE_KEYS as u32 / 2)),
            kinds: Some(vec![Kind(1), Kind(3)]),
            limit: Some(5),
            ..Filter::default()
        };
        let chosen = plan(&past_bound, &databases);
        assert_eq!(
            (chosen.path, chosen.ranges.len()),
            (AccessPath::CreatedAt, 1)
        );
        assert_page_agrees(
            &transaction,
            &databases,
            &past_bound,
            &expected,
            "past the page bound",
        );
        let fallback_page = branch(
            &transaction,
            &databases,
            &past_bound,
            &Gates::default(),
            0,
            false,
            page_limit(&past_bound),
        )
        .expect("the page");
        assert_eq!(
            index_page, fallback_page,
            "the author index and the created-at fallback return the same page"
        );
    }

    #[test]
    fn a_prefix_id_reconciliation_scans_in_bounded_batches() {
        // An exact id list is a point per id, so the list is the bound on the work; a prefix
        // criterion is a byte range over the id field, and `""` is the whole store.
        let _serial = counting();
        let (_directory, env, databases) = store();
        let records: Vec<EventRecord> = (1..=400)
            .map(|step| signed(35, 1, step, Vec::new()))
            .collect();
        write(&env, &databases, &records);
        let transaction = env.read_txn().expect("a read transaction");
        let ids = |criteria: &str| Filter {
            ids: Some(vec![criteria.to_owned()]),
            ..Filter::default()
        };

        let exact = ids(&records[10].event.id.to_string());
        assert_eq!(
            stream_plan(&exact, &databases).path,
            AccessPath::Ids,
            "an exact id list is a point per id"
        );
        let prefix = ids(&records[0].event.id.to_string()[..2]);
        assert_eq!(
            stream_plan(&prefix, &databases).path,
            AccessPath::CreatedAt,
            "a prefix criterion is a byte range, so it takes the bounded scan"
        );

        for filter in [ids(""), prefix] {
            probes::reset();
            let mut position = Position::new();
            let mut items = scan_batch(
                &transaction,
                &databases,
                &filter,
                &Gates::default(),
                0,
                &mut position,
            )
            .expect("the batch");
            assert!(
                probes::keys() <= STREAM_BATCH_KEYS,
                "one poll evaluates at most the key cap: {} keys",
                probes::keys()
            );
            assert!(
                position.after.is_some(),
                "and it resumes after the last key it evaluated"
            );

            for _ in 0..8 {
                if position.index >= stream_plan(&filter, &databases).ranges.len() {
                    break;
                }
                items.extend(
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
            }
            assert_eq!(
                items,
                reference_items(&transaction, &databases, &filter),
                "the bounded scan yields every row the criterion selects, oldest first"
            );
        }
    }
}
