//! `NotificationDeliveryLogRepository` and `NotificationOutboxRepository` against Postgres.
//! Mirrors `src/repositories/notification-delivery-log-repository.ts` and
//! `src/repositories/notification-outbox-repository.ts`.

use chrono::{DateTime, Duration, Utc};
use sqlx::postgres::Postgres;
use sqlx::{Executor, PgPool};

use super::{Arg, Args, EventQuery};
use crate::error::StorageError;
use crate::repositories::{
    DeliveryLogEntry, DeliveryLogFilters, NOTIFICATION_OUTBOX_PROCESSING_LEASE_MS,
    NewDeliveryLogEntry, OutboxMessage, OutboxPayload, OutboxStatus,
};

const OUTBOX_COLUMNS: &str = "id::text AS id, event_type, payload, status, attempt_count, \
available_at, last_error, delivered_at, created_at, updated_at";

const DELIVERY_LOG_COLUMNS: &str = "id::text AS id, outbox_id::text AS outbox_id, event_type, \
target_id, target_type, status, attempt_number, error_snippet, created_at";

/// `append`: one delivery attempt, timestamped now.
pub(crate) async fn append<'e, E>(
    executor: E,
    entry: &NewDeliveryLogEntry,
) -> Result<(), StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let outbox_slot = match &entry.outbox_id {
        Some(outbox_id) => args.push(Arg::Text(outbox_id.clone())),
        None => args.push(Arg::NullText),
    };
    let event_type_slot = args.push(Arg::Text(entry.event_type.clone()));
    let target_id_slot = args.push(Arg::Text(entry.target_id.clone()));
    let target_type_slot = args.push(Arg::Text(entry.target_type.as_str().to_owned()));
    let status_slot = args.push(Arg::Text(entry.status.as_str().to_owned()));
    let attempt_slot = args.push(Arg::Int(entry.attempt_number));
    let error_slot = match &entry.error_snippet {
        Some(snippet) => args.push(Arg::Text(snippet.clone())),
        None => args.push(Arg::NullText),
    };
    let created_slot = args.push(Arg::Timestamp(Utc::now()));
    let sql = format!(
        "INSERT INTO notification_delivery_log (outbox_id, event_type, target_id, target_type, \
         status, attempt_number, error_snippet, created_at) VALUES ({outbox_slot}::uuid, \
         {event_type_slot}, {target_id_slot}, {target_type_slot}, {status_slot}, \
         {attempt_slot}, {error_slot}, {created_slot})"
    );

    EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?;
    Ok(())
}

/// `find_recent`: newest first, optionally filtered by status and event type.
pub(crate) async fn find_recent<'e, E>(
    executor: E,
    limit: u64,
    filters: &DeliveryLogFilters,
) -> Result<Vec<DeliveryLogEntry>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let mut conditions = String::new();
    if let Some(status) = filters.status {
        let slot = args.push(Arg::Text(status.as_str().to_owned()));
        conditions.push_str(&format!(" AND status = {slot}"));
    }
    if let Some(event_type) = &filters.event_type {
        let slot = args.push(Arg::Text(event_type.clone()));
        conditions.push_str(&format!(" AND event_type = {slot}"));
    }
    let limit_slot = args.push(Arg::BigInt(limit as i64));
    let sql = format!(
        "SELECT {DELIVERY_LOG_COLUMNS} FROM notification_delivery_log WHERE 1 = 1{conditions} \
         ORDER BY created_at DESC LIMIT {limit_slot}"
    );
    let rows = EventQuery { sql, args }
        .into_query()
        .fetch_all(executor)
        .await?;

    rows.iter().map(super::rows::delivery_log_entry).collect()
}

/// `findSuccessfulTargetIds`: the distinct targets that succeeded for one message.
pub(crate) async fn find_successful_target_ids<'e, E>(
    executor: E,
    outbox_id: &str,
) -> Result<Vec<String>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let outbox_slot = args.push(Arg::Text(outbox_id.to_owned()));
    let status_slot = args.push(Arg::Text(
        crate::repositories::NotificationDeliveryStatus::Success
            .as_str()
            .to_owned(),
    ));
    let sql = format!(
        "SELECT DISTINCT target_id FROM notification_delivery_log \
         WHERE outbox_id = {outbox_slot}::uuid AND status = {status_slot}"
    );
    let rows = EventQuery { sql, args }
        .into_query()
        .fetch_all(executor)
        .await?;

    rows.iter()
        .map(|row| Ok(sqlx::Row::try_get::<String, _>(row, "target_id")?))
        .collect()
}

/// `deleteOlderThan`: prunes the log by creation time.
pub(crate) async fn delete_older_than<'e, E>(
    executor: E,
    cutoff: DateTime<Utc>,
) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let cutoff_slot = args.push(Arg::Timestamp(cutoff));
    let sql = format!("DELETE FROM notification_delivery_log WHERE created_at < {cutoff_slot}");

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected())
}

/// `enqueue`: inserts a pending message and returns the stored row.
pub(crate) async fn enqueue<'e, E>(
    executor: E,
    event_type: &str,
    payload: &OutboxPayload,
) -> Result<OutboxMessage, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let mut args = Args::default();
    let event_type_slot = args.push(Arg::Text(event_type.to_owned()));
    let payload_slot = args.push(Arg::Text(payload.to_string()));
    let status_slot = args.push(Arg::Text(OutboxStatus::Pending.as_str().to_owned()));
    let available_slot = args.push(Arg::Timestamp(now));
    let created_slot = args.push(Arg::Timestamp(now));
    let updated_slot = args.push(Arg::Timestamp(now));
    let sql = format!(
        "INSERT INTO notification_outbox (event_type, payload, status, attempt_count, \
         available_at, created_at, updated_at) VALUES ({event_type_slot}, {payload_slot}::jsonb, \
         {status_slot}, 0, {available_slot}, {created_slot}, {updated_slot}) \
         RETURNING {OUTBOX_COLUMNS}"
    );
    let row = EventQuery { sql, args }
        .into_query()
        .fetch_one(executor)
        .await?;

    super::rows::outbox_message(&row)
}

/// `claimBatch`: one transaction claims pending-or-stale rows and marks them processing. It
/// opens its own transaction, exactly as the capture does.
pub(crate) async fn claim_batch(
    pool: &PgPool,
    limit: u64,
) -> Result<Vec<OutboxMessage>, StorageError> {
    let mut transaction = pool.begin().await?;
    let claimed = claim_batch_in(&mut transaction, limit).await?;
    transaction.commit().await?;
    Ok(claimed)
}

/// The claim itself, inside a transaction the caller owns.
pub(crate) async fn claim_batch_in(
    connection: &mut sqlx::PgConnection,
    limit: u64,
) -> Result<Vec<OutboxMessage>, StorageError> {
    let now = Utc::now();
    let stale = now - Duration::milliseconds(NOTIFICATION_OUTBOX_PROCESSING_LEASE_MS);

    let mut args = Args::default();
    let pending_slot = args.push(Arg::Text(OutboxStatus::Pending.as_str().to_owned()));
    let processing_slot = args.push(Arg::Text(OutboxStatus::Processing.as_str().to_owned()));
    let now_slot = args.push(Arg::Timestamp(now));
    let stale_slot = args.push(Arg::Timestamp(stale));
    let limit_slot = args.push(Arg::BigInt(limit as i64));
    let sql = format!(
        "SELECT {OUTBOX_COLUMNS} FROM notification_outbox \
         WHERE (status = {pending_slot} AND available_at <= {now_slot}) \
         OR (status = {processing_slot} AND updated_at < {stale_slot}) \
         ORDER BY created_at ASC LIMIT {limit_slot} FOR UPDATE SKIP LOCKED"
    );
    let rows = EventQuery { sql, args }
        .into_query()
        .fetch_all(&mut *connection)
        .await?;

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let mut claimed = Vec::with_capacity(rows.len());
    let mut ids = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: String = sqlx::Row::try_get(row, "id")?;
        ids.push(id.clone());
        let mut message = super::rows::outbox_message(row)?;
        message.status = OutboxStatus::Processing;
        message.updated_at = now;
        claimed.push(message);
    }

    let mut args = Args::default();
    let processing_slot = args.push(Arg::Text(OutboxStatus::Processing.as_str().to_owned()));
    let now_slot = args.push(Arg::Timestamp(now));
    let ids_slot = args.push(Arg::TextList(ids));
    let sql = format!(
        "UPDATE notification_outbox SET status = {processing_slot}, updated_at = {now_slot} \
         WHERE id = ANY({ids_slot}::uuid[])"
    );
    EventQuery { sql, args }
        .into_query()
        .execute(&mut *connection)
        .await?;

    Ok(claimed)
}

/// `markDelivered`: delivered, timestamped, error cleared.
pub(crate) async fn mark_delivered<'e, E>(executor: E, id: &str) -> Result<(), StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let mut args = Args::default();
    let delivered_slot = args.push(Arg::Text(OutboxStatus::Delivered.as_str().to_owned()));
    let now_slot = args.push(Arg::Timestamp(now));
    let updated_slot = args.push(Arg::Timestamp(now));
    let id_slot = args.push(Arg::Text(id.to_owned()));
    let sql = format!(
        "UPDATE notification_outbox SET status = {delivered_slot}, delivered_at = {now_slot}, \
         last_error = NULL, updated_at = {updated_slot} WHERE id = {id_slot}::uuid"
    );

    EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?;
    Ok(())
}

/// `markFailed`: a retry with capped exponential backoff, or the dead transition.
pub(crate) async fn mark_failed<'e, E>(
    executor: E,
    id: &str,
    error: &str,
    attempt_count: i32,
    max_attempts: i32,
    base_delay_ms: i64,
) -> Result<(), StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let is_dead = attempt_count >= max_attempts;
    let backoff = backoff_ms(base_delay_ms, attempt_count);
    let available_at = if is_dead {
        now
    } else {
        now + Duration::milliseconds(backoff)
    };

    let mut args = Args::default();
    let status = if is_dead {
        OutboxStatus::Dead
    } else {
        OutboxStatus::Pending
    };
    let status_slot = args.push(Arg::Text(status.as_str().to_owned()));
    let attempts_slot = args.push(Arg::Int(attempt_count));
    let available_slot = args.push(Arg::Timestamp(available_at));
    let error_slot = args.push(Arg::Text(truncate_bytes(error, 2000)));
    let updated_slot = args.push(Arg::Timestamp(now));
    let id_slot = args.push(Arg::Text(id.to_owned()));
    let sql = format!(
        "UPDATE notification_outbox SET status = {status_slot}, attempt_count = {attempts_slot}, \
         available_at = {available_slot}, last_error = {error_slot}, updated_at = {updated_slot} \
         WHERE id = {id_slot}::uuid"
    );

    EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?;
    Ok(())
}

/// `deleteTerminalOlderThan`: prunes delivered and dead messages.
pub(crate) async fn delete_terminal_older_than<'e, E>(
    executor: E,
    cutoff: DateTime<Utc>,
) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let statuses = args.push(Arg::TextList(vec![
        OutboxStatus::Delivered.as_str().to_owned(),
        OutboxStatus::Dead.as_str().to_owned(),
    ]));
    let cutoff_slot = args.push(Arg::Timestamp(cutoff));
    let sql = format!(
        "DELETE FROM notification_outbox WHERE status = ANY({statuses}) \
         AND updated_at < {cutoff_slot}"
    );

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected())
}

/// `min(60_000, max(0, base_delay_ms) * 2^max(0, attempt_count - 1))`, computed without
/// overflowing for any attempt count.
fn backoff_ms(base_delay_ms: i64, attempt_count: i32) -> i64 {
    let base = i128::from(base_delay_ms.max(0));
    let exponent = u32::try_from(attempt_count.saturating_sub(1).max(0)).unwrap_or(u32::MAX);
    let factor = if exponent >= 62 {
        i128::MAX
    } else {
        1i128 << exponent
    };
    i64::try_from(base.saturating_mul(factor).min(60_000)).unwrap_or(60_000)
}

/// Truncates at a character boundary, keeping at most `limit` bytes.
fn truncate_bytes(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn the_backoff_doubles_and_caps_at_a_minute() {
        assert_eq!(backoff_ms(1000, 1), 1000);
        assert_eq!(backoff_ms(1000, 2), 2000);
        assert_eq!(backoff_ms(1000, 3), 4000);
        assert_eq!(backoff_ms(100_000, 2), 60_000);
        assert_eq!(backoff_ms(-5, 1), 0);
    }

    #[test]
    fn the_backoff_does_not_overflow_at_a_large_attempt_count() {
        assert_eq!(backoff_ms(1000, i32::MAX), 60_000);
        assert_eq!(backoff_ms(i64::MAX, 2), 60_000);
    }

    #[test]
    fn an_error_snippet_is_truncated_at_a_character_boundary() {
        assert_eq!(truncate_bytes("abcd", 10), "abcd");
        assert_eq!(truncate_bytes("abcdef", 4), "abcd");
        // "é" is two bytes, so cutting at 3 would split it.
        assert_eq!(truncate_bytes("aéé", 3), "aé");
    }
}
