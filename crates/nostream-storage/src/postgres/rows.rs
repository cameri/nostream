//! Row-to-record conversion. Every decode is explicit: the bytea columns become the core
//! hex newtypes, the jsonb columns become tags and deduplication values, `inet` is read as
//! text, `timestamp` as UTC, and the integer columns are range-checked.

use std::net::IpAddr;
use std::str::FromStr;

use chrono::{DateTime, NaiveDateTime, Utc};
use nostream_core::{Event, EventId, Pubkey, Signature, Tag};
use sqlx::Row;
use sqlx::postgres::PgRow;

use crate::error::StorageError;
use crate::records::{kind_from_i32, utc_from_naive};
use crate::repositories::{
    DeliveryLogEntry, DvmJob, InviteCode, Invoice, Nip05Verification, OutboxMessage,
    ReconciliationItem, Report, User,
};

/// One stored event row.
pub(crate) fn event_record(row: &PgRow) -> Result<crate::repositories::EventRecord, StorageError> {
    let event = Event {
        id: event_id(row, "event_id")?,
        pubkey: pubkey(row, "event_pubkey")?,
        created_at: i64::from(event_time(row, "event_created_at")?),
        kind: kind_from_i32(row.try_get::<i32, _>("event_kind")?)?,
        tags: tags(row)?,
        content: row.try_get::<String, _>("event_content")?,
        sig: signature(row, "event_signature")?,
    };

    Ok(crate::repositories::EventRecord {
        row_id: Some(row.try_get::<String, _>("id")?),
        event,
        first_seen: optional_timestamp(row, "first_seen")?,
        deleted_at: optional_timestamp(row, "deleted_at")?,
        expires_at: optional_int(row, "expires_at")?.map(i64::from),
        event_deduplication: optional_json_array(row, "event_deduplication")?,
        remote_address: optional_address(row, "remote_address")?,
    })
}

/// One reconciliation row.
pub(crate) fn reconciliation_item(row: &PgRow) -> Result<ReconciliationItem, StorageError> {
    Ok(ReconciliationItem {
        created_at: i64::from(event_time(row, "event_created_at")?),
        event_id: event_id(row, "event_id")?,
    })
}

/// One user row.
pub(crate) fn user(row: &PgRow) -> Result<User, StorageError> {
    Ok(User {
        pubkey: pubkey(row, "pubkey")?,
        is_admitted: row.try_get::<bool, _>("is_admitted")?,
        is_vanished: row.try_get::<bool, _>("is_vanished")?,
        balance: row.try_get::<i64, _>("balance")?,
        created_at: timestamptz(row, "created_at")?,
        updated_at: timestamptz(row, "updated_at")?,
    })
}

/// One invoice row.
pub(crate) fn invoice(row: &PgRow) -> Result<Invoice, StorageError> {
    Ok(Invoice {
        id: row.try_get::<String, _>("id")?,
        pubkey: pubkey(row, "pubkey")?,
        bolt11: row.try_get::<String, _>("bolt11")?,
        amount_requested: row.try_get::<i64, _>("amount_requested")?,
        amount_paid: row.try_get::<Option<i64>, _>("amount_paid")?,
        unit: enum_column(row, "unit")?,
        status: enum_column(row, "status")?,
        description: row
            .try_get::<Option<String>, _>("description")?
            .unwrap_or_default(),
        confirmed_at: optional_timestamp(row, "confirmed_at")?,
        expires_at: optional_timestamp(row, "expires_at")?,
        updated_at: timestamptz(row, "updated_at")?,
        created_at: timestamptz(row, "created_at")?,
        verify_url: row.try_get::<Option<String>, _>("verify_url")?,
    })
}

/// One NIP-05 verification row.
pub(crate) fn nip05_verification(row: &PgRow) -> Result<Nip05Verification, StorageError> {
    Ok(Nip05Verification {
        pubkey: pubkey(row, "pubkey")?,
        nip05: row.try_get::<String, _>("nip05")?,
        domain: row.try_get::<String, _>("domain")?,
        is_verified: row.try_get::<bool, _>("is_verified")?,
        last_verified_at: optional_timestamptz(row, "last_verified_at")?,
        last_checked_at: timestamptz(row, "last_checked_at")?,
        failure_count: row.try_get::<i32, _>("failure_count")?,
        created_at: timestamptz(row, "created_at")?,
        updated_at: timestamptz(row, "updated_at")?,
    })
}

/// One invite code.
pub(crate) fn invite_code(row: &PgRow) -> Result<InviteCode, StorageError> {
    Ok(InviteCode {
        code: row.try_get::<String, _>("code")?,
        created_by: optional_pubkey(row, "created_by")?,
        claimed_by: optional_pubkey(row, "claimed_by")?,
        expires_at: optional_timestamptz(row, "expires_at")?,
        remaining_uses: row.try_get::<Option<i32>, _>("remaining_uses")?,
        created_at: timestamptz(row, "created_at")?,
        updated_at: timestamptz(row, "updated_at")?,
    })
}

/// One DVM job row.
pub(crate) fn dvm_job(row: &PgRow) -> Result<DvmJob, StorageError> {
    Ok(DvmJob {
        id: event_id(row, "id")?,
        requester_pubkey: pubkey(row, "requester_pubkey")?,
        kind: kind_from_i32(row.try_get::<i32, _>("kind")?)?,
        worker_index: row.try_get::<Option<i32>, _>("worker_index")?,
        status: enum_column(row, "status")?,
        result_event_id: optional_event_id(row, "result_event_id")?,
        error: row.try_get::<Option<String>, _>("error")?,
        picked_up_at: optional_timestamptz(row, "picked_up_at")?,
        completed_at: optional_timestamptz(row, "completed_at")?,
        created_at: timestamptz(row, "created_at")?,
        updated_at: timestamptz(row, "updated_at")?,
    })
}

/// One report row.
pub(crate) fn report(row: &PgRow) -> Result<Report, StorageError> {
    Ok(Report {
        id: row.try_get::<i32, _>("id")?,
        event_id: event_id(row, "event_id")?,
        reporter_pubkey: pubkey(row, "reporter_pubkey")?,
        reported_pubkey: optional_pubkey(row, "reported_pubkey")?,
        reported_event_id: optional_event_id(row, "reported_event_id")?,
        report_type: enum_column(row, "report_type")?,
        weight: row.try_get::<f32, _>("weight")?,
        actionable: row.try_get::<bool, _>("actionable")?,
        created_at: timestamptz(row, "created_at")?,
    })
}

/// One delivery-log row.
pub(crate) fn delivery_log_entry(row: &PgRow) -> Result<DeliveryLogEntry, StorageError> {
    Ok(DeliveryLogEntry {
        id: row.try_get::<String, _>("id")?,
        outbox_id: row.try_get::<Option<String>, _>("outbox_id")?,
        event_type: row.try_get::<String, _>("event_type")?,
        target_id: row.try_get::<String, _>("target_id")?,
        target_type: enum_column(row, "target_type")?,
        status: enum_column(row, "status")?,
        attempt_number: row.try_get::<i32, _>("attempt_number")?,
        error_snippet: row.try_get::<Option<String>, _>("error_snippet")?,
        created_at: timestamptz(row, "created_at")?,
    })
}

/// One outbox message.
pub(crate) fn outbox_message(row: &PgRow) -> Result<OutboxMessage, StorageError> {
    Ok(OutboxMessage {
        id: row.try_get::<String, _>("id")?,
        event_type: row.try_get::<String, _>("event_type")?,
        payload: row.try_get::<serde_json::Value, _>("payload")?,
        status: enum_column(row, "status")?,
        attempt_count: row.try_get::<i32, _>("attempt_count")?,
        available_at: timestamptz(row, "available_at")?,
        last_error: row.try_get::<Option<String>, _>("last_error")?,
        delivered_at: optional_timestamptz(row, "delivered_at")?,
        created_at: timestamptz(row, "created_at")?,
        updated_at: timestamptz(row, "updated_at")?,
    })
}

fn event_time(row: &PgRow, column: &'static str) -> Result<i32, StorageError> {
    let value = row.try_get::<i32, _>(column)?;
    if value < 0 {
        return Err(StorageError::ValueOutOfRange {
            column,
            value: value.to_string(),
        });
    }
    Ok(value)
}

fn optional_int(row: &PgRow, column: &'static str) -> Result<Option<i32>, StorageError> {
    Ok(row.try_get::<Option<i32>, _>(column)?)
}

fn event_id(row: &PgRow, column: &'static str) -> Result<EventId, StorageError> {
    Ok(EventId::from_byte_array(fixed::<32>(row, column)?))
}

fn pubkey(row: &PgRow, column: &'static str) -> Result<Pubkey, StorageError> {
    Ok(Pubkey::from_byte_array(fixed::<32>(row, column)?))
}

fn optional_pubkey(row: &PgRow, column: &'static str) -> Result<Option<Pubkey>, StorageError> {
    Ok(optional_fixed::<32>(row, column)?.map(Pubkey::from_byte_array))
}

fn optional_event_id(row: &PgRow, column: &'static str) -> Result<Option<EventId>, StorageError> {
    Ok(optional_fixed::<32>(row, column)?.map(EventId::from_byte_array))
}

fn signature(row: &PgRow, column: &'static str) -> Result<Signature, StorageError> {
    Ok(Signature::from_byte_array(fixed::<64>(row, column)?))
}

fn fixed<const N: usize>(row: &PgRow, column: &'static str) -> Result<[u8; N], StorageError> {
    let bytes: Vec<u8> = row.try_get(column)?;
    bytes
        .try_into()
        .map_err(|bytes: Vec<u8>| StorageError::ValueOutOfRange {
            column,
            value: format!("{} bytes", bytes.len()),
        })
}

fn optional_fixed<const N: usize>(
    row: &PgRow,
    column: &'static str,
) -> Result<Option<[u8; N]>, StorageError> {
    let bytes: Option<Vec<u8>> = row.try_get(column)?;
    match bytes {
        None => Ok(None),
        Some(bytes) => {
            bytes
                .try_into()
                .map(Some)
                .map_err(|bytes: Vec<u8>| StorageError::ValueOutOfRange {
                    column,
                    value: format!("{} bytes", bytes.len()),
                })
        }
    }
}

fn tags(row: &PgRow) -> Result<Vec<Tag>, StorageError> {
    let value: Option<serde_json::Value> = row.try_get("event_tags")?;
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let invalid = || StorageError::InvalidRow {
        table: "events",
        column: "event_tags",
        value: value.to_string(),
    };
    let Some(rows) = value.as_array() else {
        return Err(invalid());
    };
    let mut tags = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(items) = row.as_array() else {
            return Err(invalid());
        };
        let mut tag = Vec::with_capacity(items.len());
        for item in items {
            let Some(text) = item.as_str() else {
                return Err(invalid());
            };
            tag.push(text.to_owned());
        }
        tags.push(tag);
    }
    Ok(tags)
}

fn optional_json_array(
    row: &PgRow,
    column: &'static str,
) -> Result<Option<Vec<serde_json::Value>>, StorageError> {
    let value: Option<serde_json::Value> = row.try_get(column)?;
    let Some(value) = value else {
        return Ok(None);
    };
    value
        .as_array()
        .cloned()
        .map(Some)
        .ok_or_else(|| StorageError::InvalidRow {
            table: "events",
            column,
            value: value.to_string(),
        })
}

fn optional_address(row: &PgRow, column: &'static str) -> Result<Option<IpAddr>, StorageError> {
    let value: Option<String> = row.try_get(column)?;
    match value {
        None => Ok(None),
        Some(value) => IpAddr::from_str(&value)
            .map(Some)
            .map_err(|_| StorageError::InvalidRow {
                table: "events",
                column,
                value,
            }),
    }
}

fn optional_timestamp(
    row: &PgRow,
    column: &'static str,
) -> Result<Option<DateTime<Utc>>, StorageError> {
    let value: Option<NaiveDateTime> = row.try_get(column)?;
    Ok(value.map(utc_from_naive))
}

fn timestamptz(row: &PgRow, column: &'static str) -> Result<DateTime<Utc>, StorageError> {
    Ok(row.try_get::<DateTime<Utc>, _>(column)?)
}

fn optional_timestamptz(
    row: &PgRow,
    column: &'static str,
) -> Result<Option<DateTime<Utc>>, StorageError> {
    Ok(row.try_get::<Option<DateTime<Utc>>, _>(column)?)
}

fn enum_column<T>(row: &PgRow, column: &'static str) -> Result<T, StorageError>
where
    T: FromStr<Err = StorageError>,
{
    let value: String = row.try_get(column)?;
    value.parse()
}

/// An integer column value checked into `i32` (the `kind`, `event_created_at` and
/// `expires_at` columns).
pub(crate) fn int_column(column: &'static str, value: i64) -> Result<i32, StorageError> {
    i32::try_from(value).map_err(|_| StorageError::ValueOutOfRange {
        column,
        value: value.to_string(),
    })
}

/// The optional `bytea` column backing a nullable key.
pub(crate) fn optional_bytes(
    row: &PgRow,
    column: &'static str,
) -> Result<Option<Vec<u8>>, StorageError> {
    Ok(row.try_get::<Option<Vec<u8>>, _>(column)?)
}

/// A 32-byte `bytea` as a pubkey.
pub(crate) fn bytes_to_pubkey(
    bytes: Vec<u8>,
    column: &'static str,
) -> Result<Pubkey, StorageError> {
    bytes
        .try_into()
        .map(Pubkey::from_byte_array)
        .map_err(|bytes: Vec<u8>| StorageError::ValueOutOfRange {
            column,
            value: format!("{} bytes", bytes.len()),
        })
}

/// A 32-byte `bytea` as an event id.
pub(crate) fn bytes_to_event_id(
    bytes: Vec<u8>,
    column: &'static str,
) -> Result<EventId, StorageError> {
    bytes
        .try_into()
        .map(EventId::from_byte_array)
        .map_err(|bytes: Vec<u8>| StorageError::ValueOutOfRange {
            column,
            value: format!("{} bytes", bytes.len()),
        })
}
