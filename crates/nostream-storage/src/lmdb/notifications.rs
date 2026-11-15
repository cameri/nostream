//! `NotificationDeliveryLogRepository` and `NotificationOutboxRepository` against LMDB.
//! Mirrors `src/repositories/notification-delivery-log-repository.ts` and
//! `src/repositories/notification-outbox-repository.ts`.
//!
//! The outbox's `FOR UPDATE SKIP LOCKED` claim needs no port: LMDB has one writer, so a claim
//! cannot interleave with another claim, and it runs inside one write transaction.

use std::collections::HashSet;

use chrono::{DateTime, Duration, Utc};
use heed::{RoTxn, RwTxn};

use super::Databases;
use super::encoding;
use super::encoding::{stamp_key, text_from, text_part};
use super::rows;
use crate::error::StorageError;
use crate::repositories::{
    DeliveryLogEntry, DeliveryLogFilters, NOTIFICATION_OUTBOX_PROCESSING_LEASE_MS,
    NewDeliveryLogEntry, OutboxMessage, OutboxPayload, OutboxStatus,
};

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Counts the outbox rows a claim loaded. Only the tests read the count, so a release build
/// drops it.
fn probe_load() {
    #[cfg(test)]
    probes::load();
}

/// The work counter the claim's cost test asserts on: a claim is bounded by the rows it
/// returns, never by the backlog behind them.
#[cfg(test)]
mod probes {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Serialises the tests that count loads, so one cannot read another's numbers.
    pub(super) static COUNTING: Mutex<()> = Mutex::new(());

    static LOADS: AtomicUsize = AtomicUsize::new(0);

    pub(super) fn reset() {
        LOADS.store(0, Ordering::Relaxed);
    }

    pub(super) fn load() {
        LOADS.fetch_add(1, Ordering::Relaxed);
    }

    pub(super) fn loads() -> usize {
        LOADS.load(Ordering::Relaxed)
    }
}

// ---------------------------------------------------------------------------------------
// The delivery log.
// ---------------------------------------------------------------------------------------

fn delivery_created_key(entry: &DeliveryLogEntry) -> Vec<u8> {
    let mut key = stamp_key(entry.created_at).to_vec();
    key.extend_from_slice(entry.id.as_bytes());
    key
}

/// `outbox_id ‖ status ‖ id`, so one entry is addressable and two attempts do not share a key.
///
/// The target is in the row, not the key: a target id may be longer than an LMDB key holds,
/// and the index only has to find the entry, whose row carries the id to report.
fn delivery_outbox_key(outbox_id: &str, entry: &DeliveryLogEntry) -> Result<Vec<u8>, StorageError> {
    let mut key = text_part(outbox_id, "delivery_log_by_outbox", "outbox_id")?;
    key.extend_from_slice(&text_part(
        entry.status.as_str(),
        "delivery_log_by_outbox",
        "status",
    )?);
    key.extend_from_slice(entry.id.as_bytes());
    Ok(key)
}

/// The entry id one `delivery_log_by_outbox` key ends with.
fn delivery_outbox_id(key: &[u8]) -> Result<&str, StorageError> {
    let Some(start) = key.iter().rposition(|byte| *byte == 0) else {
        return Err(StorageError::InvalidRow {
            table: "delivery_log_by_outbox",
            column: "key",
            value: "a key without an entry id".to_owned(),
        });
    };
    text_from(&key[start + 1..], "delivery_log_by_outbox")
}

fn delivery_load(
    txn: &RoTxn<'_>,
    databases: &Databases,
    id: &str,
) -> Result<Option<DeliveryLogEntry>, StorageError> {
    let Some(value) = databases
        .notification_delivery_log
        .get(txn, id.as_bytes())?
    else {
        return Ok(None);
    };
    rows::decode("notification_delivery_log", value).map(Some)
}

/// `append`: one delivery attempt, timestamped now. The column's foreign key is enforced
/// here, because the store has no server to enforce it.
pub(crate) fn append(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    entry: &NewDeliveryLogEntry,
    now: DateTime<Utc>,
) -> Result<(), StorageError> {
    if let Some(outbox_id) = &entry.outbox_id
        && databases.outbox.get(txn, outbox_id.as_bytes())?.is_none()
    {
        return Err(StorageError::InvalidArgument {
            message: "notification_delivery_log.outbox_id must name an outbox row",
        });
    }

    let entry = DeliveryLogEntry {
        id: new_id(),
        outbox_id: entry.outbox_id.clone(),
        event_type: entry.event_type.clone(),
        target_id: entry.target_id.clone(),
        target_type: entry.target_type,
        status: entry.status,
        attempt_number: entry.attempt_number,
        error_snippet: entry.error_snippet.clone(),
        created_at: encoding::micros(now),
    };
    // The outbox key no longer carries the target, so the row's own text column is where the
    // codec's refusal is met.
    encoding::refuse_nul("notification_delivery_log", "target_id", &entry.target_id)?;
    let value = rows::encode("notification_delivery_log", &entry)?;
    databases
        .notification_delivery_log
        .put(txn, entry.id.as_bytes(), &value)?;
    databases
        .delivery_log_by_created_at
        .put(txn, &delivery_created_key(&entry), &[])?;
    if let Some(outbox_id) = &entry.outbox_id {
        databases
            .delivery_log_by_outbox
            .put(txn, &delivery_outbox_key(outbox_id, &entry)?, &[])?;
    }
    Ok(())
}

/// Writes one delivery-log row exactly as the source carries it.
///
/// [`append`] mints the id and the timestamp and checks the outbox foreign key; a migrated row
/// arrives with its own id, its own `created_at` and an outbox row that is in the source. The
/// value and the two index keys are the same set `append` writes.
pub(super) fn delivery_write(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    entry: &DeliveryLogEntry,
) -> Result<(), StorageError> {
    let value = rows::encode("notification_delivery_log", entry)?;
    databases
        .notification_delivery_log
        .put(txn, entry.id.as_bytes(), &value)?;
    databases
        .delivery_log_by_created_at
        .put(txn, &delivery_created_key(entry), &[])?;
    if let Some(outbox_id) = &entry.outbox_id {
        databases
            .delivery_log_by_outbox
            .put(txn, &delivery_outbox_key(outbox_id, entry)?, &[])?;
    }
    Ok(())
}

/// `find_recent`: newest first, optionally filtered by status and event type.
pub(crate) fn find_recent(
    txn: &RoTxn<'_>,
    databases: &Databases,
    limit: u64,
    filters: &DeliveryLogFilters,
) -> Result<Vec<DeliveryLogEntry>, StorageError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for entry in databases.delivery_log_by_created_at.rev_iter(txn)? {
        let (key, _) = entry?;
        let id = text_from(&key[8..], "delivery_log_by_created_at")?;
        let Some(entry) = delivery_load(txn, databases, id)? else {
            continue;
        };
        if filters.status.is_some_and(|status| status != entry.status)
            || filters
                .event_type
                .as_ref()
                .is_some_and(|event_type| *event_type != entry.event_type)
        {
            continue;
        }
        entries.push(entry);
        if entries.len() as u64 >= limit {
            break;
        }
    }
    Ok(entries)
}

/// `findSuccessfulTargetIds`: the distinct targets that succeeded for one message.
pub(crate) fn find_successful_target_ids(
    txn: &RoTxn<'_>,
    databases: &Databases,
    outbox_id: &str,
) -> Result<Vec<String>, StorageError> {
    let mut prefix = text_part(outbox_id, "delivery_log_by_outbox", "outbox_id")?;
    prefix.extend_from_slice(&text_part(
        crate::repositories::NotificationDeliveryStatus::Success.as_str(),
        "delivery_log_by_outbox",
        "status",
    )?);

    let mut seen = HashSet::new();
    let mut targets = Vec::new();
    for entry in databases.delivery_log_by_outbox.prefix_iter(txn, &prefix)? {
        let (key, _) = entry?;
        let id = delivery_outbox_id(key)?;
        let Some(row) = delivery_load(txn, databases, id)? else {
            continue;
        };
        if seen.insert(row.target_id.clone()) {
            targets.push(row.target_id);
        }
    }
    Ok(targets)
}

/// `deleteOlderThan`: prunes the log by creation time.
pub(crate) fn delete_older_than(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    cutoff: DateTime<Utc>,
) -> Result<u64, StorageError> {
    let cutoff = encoding::micros(cutoff).timestamp_micros();
    let mut expired = Vec::new();
    for entry in databases.delivery_log_by_created_at.iter(txn)? {
        let (key, _) = entry?;
        if encoding::i64_from_key(&key[..8])? >= cutoff {
            break;
        }
        expired.push(text_from(&key[8..], "delivery_log_by_created_at")?.to_owned());
    }

    let mut affected = 0;
    for id in expired {
        let Some(entry) = delivery_load(txn, databases, &id)? else {
            continue;
        };
        databases
            .notification_delivery_log
            .delete(txn, id.as_bytes())?;
        databases
            .delivery_log_by_created_at
            .delete(txn, &delivery_created_key(&entry))?;
        if let Some(outbox_id) = &entry.outbox_id {
            databases
                .delivery_log_by_outbox
                .delete(txn, &delivery_outbox_key(outbox_id, &entry)?)?;
        }
        affected += 1;
    }
    Ok(affected)
}

// ---------------------------------------------------------------------------------------
// The outbox.
// ---------------------------------------------------------------------------------------

fn outbox_created_key(message: &OutboxMessage) -> Result<Vec<u8>, StorageError> {
    let mut key = text_part(
        message.status.as_str(),
        "outbox_by_status_created_at",
        "status",
    )?;
    key.extend_from_slice(&stamp_key(message.created_at));
    key.extend_from_slice(message.id.as_bytes());
    Ok(key)
}

fn outbox_updated_key(message: &OutboxMessage) -> Result<Vec<u8>, StorageError> {
    let mut key = text_part(
        message.status.as_str(),
        "outbox_by_status_updated_at",
        "status",
    )?;
    key.extend_from_slice(&stamp_key(message.updated_at));
    key.extend_from_slice(message.id.as_bytes());
    Ok(key)
}

fn outbox_load(
    txn: &RoTxn<'_>,
    databases: &Databases,
    id: &str,
) -> Result<Option<OutboxMessage>, StorageError> {
    let Some(value) = databases.outbox.get(txn, id.as_bytes())? else {
        return Ok(None);
    };
    rows::decode("notification_outbox", value).map(Some)
}

/// Writes a message and its two status indexes, removing the entries of the row it replaces.
pub(super) fn outbox_write(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    message: &OutboxMessage,
    previous: Option<&OutboxMessage>,
) -> Result<(), StorageError> {
    let value = rows::encode("notification_outbox", message)?;
    databases.outbox.put(txn, message.id.as_bytes(), &value)?;
    if let Some(previous) = previous {
        databases
            .outbox_by_status_created_at
            .delete(txn, &outbox_created_key(previous)?)?;
        databases
            .outbox_by_status_updated_at
            .delete(txn, &outbox_updated_key(previous)?)?;
    }
    databases
        .outbox_by_status_created_at
        .put(txn, &outbox_created_key(message)?, &[])?;
    databases
        .outbox_by_status_updated_at
        .put(txn, &outbox_updated_key(message)?, &[])?;
    Ok(())
}

/// `enqueue`: inserts a pending message and returns the stored row.
pub(crate) fn enqueue(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    event_type: &str,
    payload: &OutboxPayload,
    now: DateTime<Utc>,
) -> Result<OutboxMessage, StorageError> {
    let now = encoding::micros(now);
    let message = OutboxMessage {
        id: new_id(),
        event_type: event_type.to_owned(),
        payload: payload.clone(),
        status: OutboxStatus::Pending,
        attempt_count: 0,
        available_at: now,
        last_error: None,
        delivered_at: None,
        created_at: now,
        updated_at: now,
    };
    outbox_write(txn, databases, &message, None)?;
    Ok(message)
}

/// `claimBatch`: pending rows that are due and processing rows whose lease expired, oldest
/// first, marked processing in the same write transaction.
pub(crate) fn claim_batch(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    limit: u64,
    now: DateTime<Utc>,
) -> Result<Vec<OutboxMessage>, StorageError> {
    let now = encoding::micros(now);
    let stale = now - Duration::milliseconds(NOTIFICATION_OUTBOX_PROCESSING_LEASE_MS);

    let mut candidates = Vec::new();
    // Each status range runs in creation order, so the merge only needs the first `limit`
    // eligible rows of each: the global first `limit` cannot need more from either one. The
    // backlog is never materialised: a small claim reads a small slice whatever it holds.
    let take = usize::try_from(limit).unwrap_or(usize::MAX);
    if take == 0 {
        return Ok(Vec::new());
    }
    for status in [OutboxStatus::Pending, OutboxStatus::Processing] {
        let prefix = text_part(status.as_str(), "outbox_by_status_created_at", "status")?;
        let mut taken = 0;
        for entry in databases
            .outbox_by_status_created_at
            .prefix_iter(txn, &prefix)?
        {
            let (key, _) = entry?;
            let id = text_from(&key[prefix.len() + 8..], "outbox_by_status_created_at")?;
            let Some(message) = outbox_load(txn, databases, id)? else {
                continue;
            };
            probe_load();
            let due = match status {
                OutboxStatus::Pending => message.available_at <= now,
                OutboxStatus::Processing => message.updated_at < stale,
                OutboxStatus::Delivered | OutboxStatus::Dead => false,
            };
            if due {
                candidates.push(message);
                taken += 1;
                if taken >= take {
                    break;
                }
            }
        }
    }
    candidates.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    candidates.truncate(take);

    let mut claimed = Vec::with_capacity(candidates.len());
    for message in candidates {
        let previous = message.clone();
        let mut message = message;
        message.status = OutboxStatus::Processing;
        message.updated_at = now;
        outbox_write(txn, databases, &message, Some(&previous))?;
        claimed.push(message);
    }
    Ok(claimed)
}

/// `markDelivered`: delivered, timestamped, error cleared.
pub(crate) fn mark_delivered(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    id: &str,
    now: DateTime<Utc>,
) -> Result<(), StorageError> {
    let Some(mut message) = outbox_load(txn, databases, id)? else {
        return Ok(());
    };
    let previous = message.clone();
    let now = encoding::micros(now);
    message.status = OutboxStatus::Delivered;
    message.delivered_at = Some(now);
    message.last_error = None;
    message.updated_at = now;
    outbox_write(txn, databases, &message, Some(&previous))
}

/// `markFailed`: a retry with capped exponential backoff, or the dead transition.
#[allow(clippy::too_many_arguments)]
pub(crate) fn mark_failed(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    id: &str,
    error: &str,
    attempt_count: i32,
    max_attempts: i32,
    base_delay_ms: i64,
    now: DateTime<Utc>,
) -> Result<(), StorageError> {
    let Some(mut message) = outbox_load(txn, databases, id)? else {
        return Ok(());
    };
    let previous = message.clone();
    let now = encoding::micros(now);
    let dead = attempt_count >= max_attempts;
    message.status = if dead {
        OutboxStatus::Dead
    } else {
        OutboxStatus::Pending
    };
    message.attempt_count = attempt_count;
    message.available_at = if dead {
        now
    } else {
        now + Duration::milliseconds(backoff_ms(base_delay_ms, attempt_count))
    };
    message.last_error = Some(truncate_bytes(error, 2_000));
    message.updated_at = now;
    outbox_write(txn, databases, &message, Some(&previous))
}

/// `deleteTerminalOlderThan`: prunes delivered and dead messages, and nulls the outbox id of
/// every delivery-log entry that named one.
pub(crate) fn delete_terminal_older_than(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    cutoff: DateTime<Utc>,
) -> Result<u64, StorageError> {
    let cutoff = encoding::micros(cutoff).timestamp_micros();
    let mut terminal = Vec::new();
    for status in [OutboxStatus::Delivered, OutboxStatus::Dead] {
        let prefix = text_part(status.as_str(), "outbox_by_status_updated_at", "status")?;
        for entry in databases
            .outbox_by_status_updated_at
            .prefix_iter(txn, &prefix)?
        {
            let (key, _) = entry?;
            if encoding::i64_from_key(&key[prefix.len()..prefix.len() + 8])? >= cutoff {
                break;
            }
            terminal.push(
                text_from(&key[prefix.len() + 8..], "outbox_by_status_updated_at")?.to_owned(),
            );
        }
    }

    let mut affected = 0;
    for id in terminal {
        let Some(message) = outbox_load(txn, databases, &id)? else {
            continue;
        };
        databases.outbox.delete(txn, id.as_bytes())?;
        databases
            .outbox_by_status_created_at
            .delete(txn, &outbox_created_key(&message)?)?;
        databases
            .outbox_by_status_updated_at
            .delete(txn, &outbox_updated_key(&message)?)?;
        null_delivery_outbox(txn, databases, &id)?;
        affected += 1;
    }
    Ok(affected)
}

/// Sets `outbox_id` to `NULL` on every delivery-log row that named this outbox row.
fn null_delivery_outbox(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    outbox_id: &str,
) -> Result<(), StorageError> {
    let prefix = text_part(outbox_id, "delivery_log_by_outbox", "outbox_id")?;
    let mut named = Vec::new();
    for entry in databases.delivery_log_by_outbox.prefix_iter(txn, &prefix)? {
        let (key, _) = entry?;
        named.push((key.to_vec(), delivery_outbox_id(key)?.to_owned()));
    }

    for (index_key, id) in named {
        let Some(mut row) = delivery_load(txn, databases, &id)? else {
            continue;
        };
        databases.delivery_log_by_outbox.delete(txn, &index_key)?;
        row.outbox_id = None;
        let value = rows::encode("notification_delivery_log", &row)?;
        databases
            .notification_delivery_log
            .put(txn, row.id.as_bytes(), &value)?;
    }
    Ok(())
}

/// `min(60_000, max(0, base_delay_ms) * 2^max(0, attempt_count - 1))`, the same rule as
/// `postgres::notifications::backoff_ms`; kept local because that module is behind its own
/// feature and neither backend may depend on the other's.
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
    use crate::backend::LmdbEnv;
    use crate::repositories::{NotificationDeliveryStatus, NotificationTargetType};
    use heed::Env;

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

    fn now() -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(1_700_000_000, 0).expect("an instant")
    }

    /// A claim is bounded by the rows it returns: a small request over a large backlog reads
    /// the head of each status range, not the backlog.
    #[test]
    fn a_small_claim_does_not_load_the_backlog() {
        let _serial = probes::COUNTING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_directory, env, databases) = store();
        let now = now();

        let mut transaction = env.write_txn().expect("a write transaction");
        for step in 0..200 {
            enqueue(
                &mut transaction,
                &databases,
                "test",
                &serde_json::json!({ "step": step }),
                now,
            )
            .expect("a message");
        }
        transaction.commit().expect("the commit");

        let mut transaction = env.write_txn().expect("a write transaction");
        probes::reset();
        let claimed = claim_batch(&mut transaction, &databases, 5, now).expect("the claim");
        let loads = probes::loads();
        transaction.commit().expect("the commit");

        assert_eq!(claimed.len(), 5, "the claim is the request's size");
        assert!(
            loads <= 10,
            "a claim reads the head of each status range, not the backlog: {loads} rows loaded"
        );
    }

    /// A target id may be longer than an LMDB key holds: the delivery index keys the entry, and
    /// the row carries the target, so the success is recorded and reported.
    #[test]
    fn a_long_target_id_still_reaches_its_delivery_record() {
        let (_directory, env, databases) = store();
        let now = now();
        let target = "t".repeat(430);

        let mut transaction = env.write_txn().expect("a write transaction");
        let message = enqueue(
            &mut transaction,
            &databases,
            "test",
            &serde_json::json!({}),
            now,
        )
        .expect("a message");
        let entry = NewDeliveryLogEntry {
            outbox_id: Some(message.id.clone()),
            event_type: "test".to_owned(),
            target_id: target.clone(),
            target_type: NotificationTargetType::Telegram,
            status: NotificationDeliveryStatus::Success,
            attempt_number: 1,
            error_snippet: None,
        };
        append(&mut transaction, &databases, &entry, now).expect("the log row");
        let targets = find_successful_target_ids(&transaction, &databases, &message.id)
            .expect("the successful targets");
        transaction.commit().expect("the commit");

        assert_eq!(targets, vec![target]);
    }
}
