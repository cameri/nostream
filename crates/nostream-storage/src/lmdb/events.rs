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
use super::{DEFAULT_FILTER_LIMIT, Databases, Gates, RETENTION_BATCH_SIZE, STREAM_BATCH_ITEMS};
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

/// One database's inclusive key range.
type KeyRange = (Vec<u8>, Vec<u8>);

/// The index one filter is answered from, how its keys are read back, and the ranges to walk.
type IndexRanges = (Database<Bytes, Bytes>, AccessPath, Vec<KeyRange>);

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
        let limit = Some(
            usize::try_from(filter.limit.unwrap_or(DEFAULT_FILTER_LIMIT)).unwrap_or(usize::MAX),
        );
        for candidate in branch(txn, databases, filter, gates, now, false, limit)? {
            if seen.insert(candidate) {
                union.push(candidate);
            }
        }
    }
    sort_page(&mut union, filters[0].limit.is_some());
    Ok(union)
}

/// The count of the live ids the filters match, deduplicated across filters.
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

    let mut ids = HashSet::new();
    for filter in filters {
        let limit = filter
            .limit
            .map(|limit| usize::try_from(limit).unwrap_or(usize::MAX));
        for (_, id) in branch(txn, databases, filter, gates, now, true, limit)? {
            ids.insert(id);
        }
    }
    Ok(ids.len() as u64)
}

/// One filter's page: up to `limit` matching keys, ordered as the capture's branch is.
fn branch(
    txn: &RoTxn<'_>,
    databases: &Databases,
    filter: &Filter,
    gates: &Gates,
    now: i64,
    live: bool,
    limit: Option<usize>,
) -> Result<Vec<(i64, EventId)>, StorageError> {
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
    if filter.ids.as_ref().is_some_and(|ids| ids.is_empty())
        || filter
            .authors
            .as_ref()
            .is_some_and(|authors| authors.is_empty())
        || filter
            .tags
            .iter()
            .any(|(key, criteria)| generic_tag_name(key).is_some() && criteria.is_empty())
    {
        return Ok(Vec::new());
    }

    let matcher = Matcher {
        filter,
        gates,
        now,
        live,
    };
    let (database, path, ranges) = choose_ranges(filter, databases);
    let descending = filter.limit.is_some();
    let mut matches: Vec<(i64, EventId)> = Vec::new();
    let mut seen = HashSet::new();
    let mut boundary: Option<i64> = None;

    for (low, high) in &ranges {
        let range = encoding::bounds(low, high);
        if path == AccessPath::CreatedAt && descending {
            for entry in database.rev_range(txn, &range)? {
                let (key, _) = entry?;
                let Some((created_at, id)) = key_candidate(path, key)? else {
                    continue;
                };
                if boundary.is_some_and(|bound| created_at < bound) {
                    break;
                }
                if matcher.matches(txn, databases, &id)?.is_some() {
                    push(&mut matches, &mut seen, (created_at, id));
                    if limit.is_some_and(|limit| matches.len() >= limit) {
                        boundary = Some(created_at);
                    }
                }
            }
        } else {
            for entry in database.range(txn, &range)? {
                let (key, _) = entry?;
                let Some(found) = candidate(txn, databases, path, key)? else {
                    continue;
                };
                if boundary.is_some_and(|bound| found.0 > bound) {
                    break;
                }
                if matcher.matches(txn, databases, &found.1)?.is_some() {
                    push(&mut matches, &mut seen, found);
                    if limit.is_some_and(|limit| matches.len() >= limit) {
                        boundary = Some(found.0);
                    }
                }
            }
        }
    }

    // A limit on any other index is applied after the page is ordered, exactly as the
    // capture's `ORDER BY … LIMIT` is.
    sort_page(&mut matches, descending);
    if let Some(limit) = limit {
        matches.truncate(limit);
    }
    Ok(matches)
}

fn push(matches: &mut Vec<(i64, EventId)>, seen: &mut HashSet<EventId>, candidate: (i64, EventId)) {
    if seen.insert(candidate.1) {
        matches.push(candidate);
    }
}

fn sort_page(page: &mut [(i64, EventId)], descending: bool) {
    if descending {
        page.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    } else {
        page.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    }
}

/// The index a filter is answered from, and the ranges within it.
fn choose_ranges(
    filter: &Filter,
    databases: &Databases,
) -> IndexRanges {
    if let Some(ids) = &filter.ids
        && !ids.is_empty()
    {
        return (
            databases.events,
            AccessPath::Ids,
            encoding::hex_ranges(ids, 0),
        );
    }
    if let Some(authors) = &filter.authors
        && !authors.is_empty()
    {
        return (
            databases.events_by_author,
            AccessPath::Authors,
            encoding::hex_ranges(authors, 4 + 8 + 32),
        );
    }
    if let Some((name, criteria)) = tag_path(filter) {
        return (
            databases.tags,
            AccessPath::Tags,
            encoding::tag_ranges(name, criteria),
        );
    }
    (
        databases.events_by_created_at,
        AccessPath::CreatedAt,
        created_at_ranges(filter),
    )
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
        if self
            .filter
            .tags
            .keys()
            .any(|key| generic_tag_name(key).is_some())
            && !tag_criteria_match(&self.filter.tags, &rows::decode_event(value)?)
        {
            return Ok(None);
        }
        Ok(Some(header))
    }

    /// The capture's `NOT EXISTS (… reports …)`: one point lookup per target column.
    fn reported(
        &self,
        txn: &RoTxn<'_>,
        databases: &Databases,
        id: &EventId,
        pubkey: &Pubkey,
    ) -> Result<bool, StorageError> {
        if has_prefix(databases.reports_actionable_event, txn, id.as_bytes(), 4)? {
            return Ok(true);
        }
        has_prefix(
            databases.reports_actionable_pubkey,
            txn,
            pubkey.as_bytes(),
            4,
        )
    }
}

fn has_prefix(
    database: Database<Bytes, Bytes>,
    txn: &RoTxn<'_>,
    prefix: &[u8],
    suffix: usize,
) -> Result<bool, StorageError> {
    let mut upper = prefix.to_vec();
    upper.extend(std::iter::repeat_n(0xff, suffix));
    let range = (Bound::Included(prefix), Bound::Included(upper.as_slice()));
    Ok(database.range(txn, &range)?.next().transpose()?.is_some())
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

/// Every tag criterion of a filter, under the capture's rules: a value is exact, and only
/// `#g` honours a trailing `*` as a prefix.
fn tag_criteria_match(tags: &BTreeMap<String, Vec<String>>, record: &EventRecord) -> bool {
    for (key, criteria) in tags {
        let Some(name) = generic_tag_name(key) else {
            continue;
        };
        if criteria.is_empty() {
            return false;
        }
        let is_geohash = key == "#g";
        let matched = record.event.tags.iter().any(|tag| {
            if tag.first().map(String::as_str) != Some(name) {
                return false;
            }
            let Some(value) = tag.get(1) else {
                return false;
            };
            criteria.iter().any(|criterion| {
                match criterion.strip_suffix('*').filter(|_| is_geohash) {
                    Some(prefix) => value.starts_with(prefix),
                    None => value == criterion,
                }
            })
        });
        if !matched {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------------------
// Streams.
// ---------------------------------------------------------------------------------------

/// One batch of keys a stream has read, and where the next batch resumes.
struct Position {
    ranges: Vec<KeyRange>,
    index: usize,
    after: Option<Vec<u8>>,
}

impl Position {
    fn new(filter: &Filter) -> Self {
        Self {
            ranges: created_at_ranges(filter),
            index: 0,
            after: None,
        }
    }
}

/// Reads one page of values in batches of [`STREAM_BATCH_ITEMS`], one read transaction per
/// poll, so a stream that is dropped pins no pages.
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

/// Yields the live `(created_at, event_id)` pairs a reconciliation compares, oldest first,
/// in batches of [`STREAM_BATCH_ITEMS`] keys with one read transaction per poll.
pub(crate) struct ReconciliationStream {
    env: Env,
    databases: Databases,
    filter: Filter,
    gates: Gates,
    now: i64,
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
        Self {
            env,
            databases,
            filter: filter.clone(),
            gates,
            now,
            position: Position::new(filter),
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
            let mut position = std::mem::replace(&mut this.position, Position::new(&this.filter));
            let exhausted = position.index >= position.ranges.len();
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

/// One batch of a reconciliation scan: up to [`STREAM_BATCH_ITEMS`] live keys, resuming
/// after the last key the previous batch read.
fn scan_batch(
    txn: &RoTxn<'_>,
    databases: &Databases,
    filter: &Filter,
    gates: &Gates,
    now: i64,
    position: &mut Position,
) -> Result<Vec<ReconciliationItem>, StorageError> {
    let matcher = Matcher {
        filter,
        gates,
        now,
        live: true,
    };
    let mut items = Vec::new();
    while position.index < position.ranges.len() {
        let lower = position.ranges[position.index].0.clone();
        let upper = position.ranges[position.index].1.clone();
        let after = position.after.clone();
        let range = encoding::resume_bounds(after.as_deref(), &lower, &upper);
        let mut reached_cap = false;
        for entry in databases.events_by_created_at.range(txn, &range)? {
            let (key, _) = entry?;
            position.after = Some(key.to_vec());
            if items.len() >= STREAM_BATCH_ITEMS {
                reached_cap = true;
                break;
            }
            let (created_at, event_id) =
                key_candidate(AccessPath::CreatedAt, key)?.ok_or_else(|| {
                    encoding::invalid(
                        "events_by_created_at",
                        "a key without a timestamp".to_owned(),
                    )
                })?;
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
        assert!(tag_criteria_match(&tags, &record));

        let mut tags = BTreeMap::new();
        tags.insert("#e".to_owned(), vec!["u4pru*".to_owned()]);
        assert!(!tag_criteria_match(&tags, &record));

        let mut tags = BTreeMap::new();
        tags.insert("#em".to_owned(), vec!["nothing".to_owned()]);
        assert!(tag_criteria_match(&tags, &record));
    }
}
