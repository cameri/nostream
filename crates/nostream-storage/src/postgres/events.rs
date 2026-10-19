//! `EventRepository` against Postgres. Mirrors `src/repositories/event-repository.ts`.

use std::pin::Pin;
use std::task::{Context, Poll};

use chrono::Utc;
use futures_core::Stream;
use nostream_core::{EventId, Filter, Kind, KindSelector, Pubkey};
use sqlx::postgres::{PgRow, Postgres};
use sqlx::{Executor, Row};

use super::rows::int_column;
use super::sql::{self, hex_bytes};
use super::{Arg, Args, EventQuery, Gates, RETENTION_BATCH_SIZE};
use crate::error::StorageError;
use crate::repositories::{
    EventPurgeCounts, EventRecord, EventRetentionOptions, QueryStream, ReconciliationItem,
};

/// The conflict target of every replaceable write, exactly as the capture spells it.
const REPLACEABLE_CONFLICT: &str = "(event_pubkey, event_kind, event_deduplication) WHERE \
(event_kind = 0 OR event_kind = 3 OR event_kind = 41 OR (event_kind >= 10000 AND event_kind < 20000)) \
OR (event_kind >= 30000 AND event_kind < 40000)";

/// The merge predicate: the incoming row wins only when it is newer, or equal and smaller.
const REPLACEABLE_MERGE: &str = "WHERE (events.event_created_at < excluded.event_created_at OR \
(events.event_created_at = excluded.event_created_at AND events.event_id > excluded.event_id))";

const INSERT_COLUMNS: &str = "(event_id, event_pubkey, event_created_at, event_kind, event_tags, \
event_content, event_signature, remote_address, expires_at)";

const UPSERT_COLUMNS: &str = "(event_id, event_pubkey, event_created_at, event_kind, event_tags, \
event_content, event_signature, remote_address, expires_at, event_deduplication, deleted_at)";

/// The kind of the capture's `REQUEST_TO_VANISH`, which every retention whitelist keeps.
const REQUEST_TO_VANISH: i32 = 62;

/// PostgreSQL's bind limit is 65 535 parameters per statement. One `create` row binds nine
/// parameters (`INSERT_COLUMNS`) and one `upsert` row binds ten (`UPSERT_COLUMNS`), so these
/// are the largest single-statement batches the server accepts. Up to one batch, this is
/// exactly the capture's one statement.
const CREATE_BATCH_ROWS: usize = 65_535 / 9;
const UPSERT_BATCH_ROWS: usize = 65_535 / 10;

/// `create`: `INSERT ... ON CONFLICT (event_id) DO NOTHING`, returning the row count.
pub(crate) async fn create<'e, E>(executor: E, record: &EventRecord) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres> + Copy,
{
    create_many(executor, std::slice::from_ref(record)).await
}

/// `create_many`: one multi-row insert, in batches the parameter limit allows.
pub(crate) async fn create_many<'e, E>(
    executor: E,
    records: &[EventRecord],
) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres> + Copy,
{
    if records.is_empty() {
        return Ok(0);
    }

    let mut affected = 0;
    for batch in records.chunks(CREATE_BATCH_ROWS) {
        let mut args = Args::default();
        let values = batch
            .iter()
            .map(|record| push_insert_values(&mut args, record))
            .collect::<Result<Vec<_>, _>>()?;
        let sql = format!(
            "INSERT INTO events {INSERT_COLUMNS} VALUES {} ON CONFLICT (event_id) DO NOTHING",
            values.join(", ")
        );
        affected += EventQuery { sql, args }
            .into_query()
            .execute(executor)
            .await?
            .rows_affected();
    }

    Ok(affected)
}

/// `upsert`: one replaceable insert, merging only when the incoming row wins.
pub(crate) async fn upsert<'e, E>(executor: E, record: &EventRecord) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let values = push_upsert_values(&mut args, record)?;
    let sql = format!(
        "INSERT INTO events {UPSERT_COLUMNS} VALUES {values} ON CONFLICT {REPLACEABLE_CONFLICT} \
         DO UPDATE SET deleted_at = NULL, event_content = excluded.event_content, \
         event_created_at = excluded.event_created_at, event_id = excluded.event_id, \
         event_signature = excluded.event_signature, event_tags = excluded.event_tags, \
         remote_address = excluded.remote_address, expires_at = excluded.expires_at {REPLACEABLE_MERGE}"
    );

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected())
}

/// `upsert_many`: one multi-row replaceable insert. The capture's explicit merge list omits
/// `remote_address`, and so does this one.
pub(crate) async fn upsert_many<'e, E>(
    executor: E,
    records: &[EventRecord],
) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres> + Copy,
{
    if records.is_empty() {
        return Ok(0);
    }

    let mut affected = 0;
    for batch in records.chunks(UPSERT_BATCH_ROWS) {
        let mut args = Args::default();
        let values = batch
            .iter()
            .map(|record| push_upsert_values(&mut args, record))
            .collect::<Result<Vec<_>, _>>()?;
        let sql = format!(
            "INSERT INTO events {UPSERT_COLUMNS} VALUES {} ON CONFLICT {REPLACEABLE_CONFLICT} \
             DO UPDATE SET deleted_at = excluded.deleted_at, event_content = excluded.event_content, \
             event_created_at = excluded.event_created_at, event_id = excluded.event_id, \
             event_signature = excluded.event_signature, event_tags = excluded.event_tags, \
             expires_at = excluded.expires_at {REPLACEABLE_MERGE}",
            values.join(", ")
        );
        affected += EventQuery { sql, args }
            .into_query()
            .execute(executor)
            .await?
            .rows_affected();
    }

    Ok(affected)
}
/// connection for its life.
pub(crate) fn find_by_filters<'a>(
    reader: &'a sqlx::PgPool,
    filters: &[Filter],
    gates: &Gates,
) -> Result<QueryStream<'a, EventRecord>, StorageError> {
    let query = sql::find_by_filters(filters, gates)?;
    Ok(Box::pin(EventStream {
        inner: query.into_query().fetch(reader),
    }))
}

/// `find_reconciliation_items`: the live `(created_at, event_id)` pairs, limit ignored.
pub(crate) fn find_reconciliation_items<'a>(
    reader: &'a sqlx::PgPool,
    filter: &Filter,
    gates: &Gates,
) -> Result<QueryStream<'a, ReconciliationItem>, StorageError> {
    let query = sql::find_reconciliation_items(filter, gates, Utc::now().timestamp())?;
    Ok(Box::pin(ReconciliationStream {
        inner: query.into_query().fetch(reader),
    }))
}

/// `count_by_filters`: the count of the union of the filters' live ids.
pub(crate) async fn count_by_filters<'e, E>(
    executor: E,
    filters: &[Filter],
    gates: &Gates,
) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let query = sql::count_by_filters(filters, gates, Utc::now().timestamp())?;
    let row = query.into_query().fetch_one(executor).await?;
    let count: i64 = row.try_get("count")?;
    u64::try_from(count).map_err(|_| StorageError::ValueOutOfRange {
        column: "count",
        value: count.to_string(),
    })
}

/// `delete_by_pubkey_and_ids`: a soft delete, never touching kind 62 or a deleted row.
pub(crate) async fn delete_by_pubkey_and_ids<'e, E>(
    executor: E,
    pubkey: &Pubkey,
    ids: &[EventId],
) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let pubkey_slot = args.push(Arg::Bytes(pubkey.as_bytes().to_vec()));
    let ids_slot = args.push(Arg::BytesList(
        ids.iter().map(|id| id.as_bytes().to_vec()).collect(),
    ));
    let sql = format!(
        "UPDATE events SET deleted_at = now() WHERE event_pubkey = {pubkey_slot} \
         AND event_id = ANY({ids_slot}) AND event_kind <> {REQUEST_TO_VANISH} AND deleted_at IS NULL"
    );

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected())
}

/// `delete_by_pubkey_except_kinds`: a soft delete of every other live kind.
pub(crate) async fn delete_by_pubkey_except_kinds<'e, E>(
    executor: E,
    pubkey: &Pubkey,
    excluded_kinds: &[Kind],
) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let pubkey_slot = args.push(Arg::Bytes(pubkey.as_bytes().to_vec()));
    let kinds_clause = if excluded_kinds.is_empty() {
        String::new()
    } else {
        let kinds: Vec<i32> = excluded_kinds
            .iter()
            .map(|kind| i32::try_from(kind.0).unwrap_or(i32::MAX))
            .collect();
        let kinds_slot = args.push(Arg::IntList(kinds));
        format!(" AND event_kind <> ALL({kinds_slot})")
    };
    let sql = format!(
        "UPDATE events SET deleted_at = now() WHERE event_pubkey = {pubkey_slot} {kinds_clause} \
         AND deleted_at IS NULL"
    );

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected())
}

/// `has_active_request_to_vanish`: a live kind-62 row exists.
pub(crate) async fn has_active_request_to_vanish<'e, E>(
    executor: E,
    pubkey: &Pubkey,
) -> Result<bool, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let pubkey_slot = args.push(Arg::Bytes(pubkey.as_bytes().to_vec()));
    let sql = format!(
        "SELECT event_id FROM events WHERE event_pubkey = {pubkey_slot} AND event_kind = \
         {REQUEST_TO_VANISH} AND deleted_at IS NULL LIMIT 1"
    );

    Ok(EventQuery { sql, args }
        .into_query()
        .fetch_optional(executor)
        .await?
        .is_some())
}

/// `delete_expired_and_retained`: one hard-delete batch of at most 1000 rows, classified in
/// the capture's order (deleted, then expired, then retained).
pub(crate) async fn delete_expired_and_retained<'e, E>(
    executor: E,
    options: &EventRetentionOptions,
) -> Result<EventPurgeCounts, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let Some(max_days) = options.max_days.filter(|days| *days > 0) else {
        return Ok(EventPurgeCounts::default());
    };

    let now = Utc::now().timestamp();
    let retention_limit = now.saturating_sub(max_days.saturating_mul(86_400));

    let mut args = Args::default();
    let now_slot = args.push(Arg::BigInt(now));
    let limit_slot = args.push(Arg::BigInt(retention_limit));
    let whitelist = retention_kinds(options.kind_whitelist.as_deref());
    let whitelist_sql = push_retention_kinds(&mut args, &whitelist);

    let mut pubkey_clause = String::new();
    if let Some(whitelist) = &options.pubkey_whitelist
        && !whitelist.is_empty()
    {
        let pubkeys: Vec<Vec<u8>> = whitelist
            .iter()
            .map(|pubkey| hex_bytes(&pubkey.0))
            .collect();
        let slot = args.push(Arg::BytesList(pubkeys));
        pubkey_clause = format!(" AND event_pubkey <> ALL({slot})");
    }

    let sql = format!(
        "DELETE FROM events WHERE event_id IN (SELECT event_id FROM events WHERE \
         (expires_at < {now_slot} OR deleted_at IS NOT NULL OR event_created_at < {limit_slot}) \
         AND NOT ({whitelist_sql}){pubkey_clause} LIMIT {RETENTION_BATCH_SIZE}) \
         RETURNING deleted_at, expires_at, event_created_at"
    );

    let rows = EventQuery { sql, args }
        .into_query()
        .fetch_all(executor)
        .await?;

    let mut counts = EventPurgeCounts::default();
    for row in rows {
        let deleted_at: Option<chrono::NaiveDateTime> = row.try_get("deleted_at")?;
        let expires_at: Option<i32> = row.try_get("expires_at")?;
        let created_at: i32 = row.try_get("event_created_at")?;
        if deleted_at.is_some() {
            counts.deleted += 1;
        } else if expires_at.is_some_and(|expires_at| i64::from(expires_at) < now) {
            counts.expired += 1;
        } else if i64::from(created_at) < retention_limit {
            counts.retained += 1;
        }
    }

    Ok(counts)
}

/// The capture's deduplicated whitelist, always including kind 62.
fn retention_kinds(configured: Option<&[KindSelector]>) -> Vec<KindSelector> {
    let mut seen = Vec::new();
    let mut whitelist = Vec::new();
    let mut push = |selector: KindSelector| {
        if !seen.contains(&selector) {
            seen.push(selector);
            whitelist.push(selector);
        }
    };
    for selector in configured.unwrap_or_default() {
        push(*selector);
    }
    push(KindSelector::Single(Kind(REQUEST_TO_VANISH as u64)));
    whitelist
}

fn push_retention_kinds(args: &mut Args, whitelist: &[KindSelector]) -> String {
    let mut parts = Vec::new();
    for selector in whitelist {
        match selector {
            KindSelector::Single(kind) => {
                let slot = args.push(Arg::Int(i32::try_from(kind.0).unwrap_or(i32::MAX)));
                parts.push(format!("event_kind = {slot}"));
            }
            KindSelector::Range([start, end]) => {
                let start_slot = args.push(Arg::Int(i32::try_from(start.0).unwrap_or(i32::MAX)));
                let end_slot = args.push(Arg::Int(i32::try_from(end.0).unwrap_or(i32::MAX)));
                parts.push(format!("event_kind BETWEEN {start_slot} AND {end_slot}"));
            }
        }
    }
    parts.join(" OR ")
}

fn push_insert_values(args: &mut Args, record: &EventRecord) -> Result<String, StorageError> {
    let id = args.push(Arg::Bytes(record.event.id.as_bytes().to_vec()));
    let pubkey = args.push(Arg::Bytes(record.event.pubkey.as_bytes().to_vec()));
    let created_at = args.push(Arg::Int(int_column(
        "event_created_at",
        record.event.created_at,
    )?));
    let kind = args.push(Arg::Int(int_column(
        "event_kind",
        record.event.kind.0 as i64,
    )?));
    let tags = args.push(Arg::Text(tags_json(record)?));
    let content = args.push(Arg::Text(record.event.content.clone()));
    let signature = args.push(Arg::Bytes(record.event.sig.as_bytes().to_vec()));
    let remote_address = match record.remote_address {
        Some(address) => args.push(Arg::Text(address.to_string())),
        None => args.push(Arg::NullText),
    };
    let expires_at = match record.expires_at {
        Some(expires_at) => args.push(Arg::Int(int_column("expires_at", expires_at)?)),
        None => args.push(Arg::NullInt),
    };

    Ok(format!(
        "({id}, {pubkey}, {created_at}, {kind}, {tags}::jsonb, {content}, {signature}, \
         {remote_address}::text::inet, {expires_at})"
    ))
}

fn push_upsert_values(args: &mut Args, record: &EventRecord) -> Result<String, StorageError> {
    let insert = push_insert_values(args, record)?;
    let deduplication =
        serde_json::to_string(&record.deduplication()).map_err(|_| StorageError::InvalidRow {
            table: "events",
            column: "event_deduplication",
            value: "the deduplication value is not JSON".to_owned(),
        })?;
    let deduplication = args.push(Arg::Text(deduplication));

    let insert = insert.strip_suffix(')').unwrap_or(&insert);
    // The upsert tuple carries two more columns than the insert tuple.
    Ok(format!("{insert}, {deduplication}::jsonb, NULL)"))
}

fn tags_json(record: &EventRecord) -> Result<String, StorageError> {
    serde_json::to_string(&record.event.tags).map_err(|_| StorageError::InvalidRow {
        table: "events",
        column: "event_tags",
        value: "the tags are not a JSON array".to_owned(),
    })
}

/// A stream of stored events, mapping each driver row.
struct EventStream<'a> {
    inner: Pin<Box<dyn Stream<Item = Result<PgRow, sqlx::Error>> + Send + 'a>>,
}

impl Stream for EventStream<'_> {
    type Item = Result<EventRecord, StorageError>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        match this.inner.as_mut().poll_next(context) {
            Poll::Ready(Some(Ok(row))) => Poll::Ready(Some(super::rows::event_record(&row))),
            Poll::Ready(Some(Err(error))) => Poll::Ready(Some(Err(StorageError::Database(error)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// A stream of reconciliation items, mapping each driver row.
struct ReconciliationStream<'a> {
    inner: Pin<Box<dyn Stream<Item = Result<PgRow, sqlx::Error>> + Send + 'a>>,
}

impl Stream for ReconciliationStream<'_> {
    type Item = Result<ReconciliationItem, StorageError>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        match this.inner.as_mut().poll_next(context) {
            Poll::Ready(Some(Ok(row))) => Poll::Ready(Some(super::rows::reconciliation_item(&row))),
            Poll::Ready(Some(Err(error))) => Poll::Ready(Some(Err(StorageError::Database(error)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn the_retention_whitelist_deduplicates_and_always_keeps_kind_62() {
        let whitelist = retention_kinds(Some(&[
            KindSelector::Single(Kind(1)),
            KindSelector::Range([Kind(1), Kind(1)]),
            KindSelector::Single(Kind(62)),
            KindSelector::Single(Kind(1)),
        ]));
        assert_eq!(
            whitelist,
            vec![
                KindSelector::Single(Kind(1)),
                KindSelector::Range([Kind(1), Kind(1)]),
                KindSelector::Single(Kind(62)),
            ]
        );

        let default = retention_kinds(None);
        assert_eq!(default, vec![KindSelector::Single(Kind(62))]);
    }

    #[test]
    fn the_retention_whitelist_clause_names_kinds_and_ranges() {
        let mut args = Args::default();
        let clause = push_retention_kinds(
            &mut args,
            &[
                KindSelector::Single(Kind(1)),
                KindSelector::Range([Kind(10_000), Kind(19_999)]),
            ],
        );
        assert_eq!(clause, "event_kind = $1 OR event_kind BETWEEN $2 AND $3");
        assert_eq!(args.len(), 3);
    }
}
