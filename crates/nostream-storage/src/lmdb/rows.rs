//! Per-row encode and decode for the LMDB store: one format byte, the event's fixed header,
//! then `serde_json` of the row the seam already declares.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::encoding::{self, EVENT_HEADER_LEN, EventHeader, ROW_FORMAT_VERSION};
use crate::error::StorageError;
use crate::repositories::{EventRecord, User};

/// One stored `users` row: the seam's [`User`] plus `tos_accepted_at`, which
/// `fromDBUser` omits from the read shape but a write still carries.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct StoredUser {
    pub pubkey: nostream_core::Pubkey,
    pub is_admitted: bool,
    pub is_vanished: bool,
    pub balance: i64,
    pub tos_accepted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl StoredUser {
    /// A new row with the capture's column defaults.
    pub(crate) fn new(pubkey: nostream_core::Pubkey, now: DateTime<Utc>) -> Self {
        Self {
            pubkey,
            is_admitted: false,
            is_vanished: false,
            balance: 0,
            tos_accepted_at: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// The read shape the seam returns (`fromDBUser` drops `tos_accepted_at`).
    pub(crate) fn user(self) -> User {
        User {
            pubkey: self.pubkey,
            is_admitted: self.is_admitted,
            is_vanished: self.is_vanished,
            balance: self.balance,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// Encodes one value: the format byte, then the JSON document.
pub(crate) fn encode<T>(table: &'static str, row: &T) -> Result<Vec<u8>, StorageError>
where
    T: Serialize,
{
    let mut value = Vec::from([ROW_FORMAT_VERSION]);
    value.extend(
        serde_json::to_vec(row).map_err(|error| StorageError::InvalidRow {
            table,
            column: "value",
            value: error.to_string(),
        })?,
    );
    Ok(value)
}

/// Decodes one value written by [`encode`].
pub(crate) fn decode<T>(table: &'static str, value: &[u8]) -> Result<T, StorageError>
where
    T: DeserializeOwned,
{
    encoding::check_version(table, value)?;
    serde_json::from_slice(&value[1..]).map_err(|error| StorageError::InvalidRow {
        table,
        column: "value",
        value: error.to_string(),
    })
}

/// Encodes one event value: version byte, fixed header, JSON of the whole record.
pub(crate) fn encode_event(record: &EventRecord) -> Result<Vec<u8>, StorageError> {
    let kind = i32::try_from(record.event.kind.0).map_err(|_| StorageError::ValueOutOfRange {
        column: "event_kind",
        value: record.event.kind.0.to_string(),
    })?;
    let header = EventHeader {
        deleted: record.deleted_at.is_some(),
        created_at: record.event.created_at,
        kind,
        expires_at: record.expires_at,
        pubkey: record.event.pubkey,
    };
    let mut value = Vec::with_capacity(1 + EVENT_HEADER_LEN + 256);
    value.push(ROW_FORMAT_VERSION);
    value.extend_from_slice(&encoding::header_bytes(&header));
    value.extend(
        serde_json::to_vec(record).map_err(|error| StorageError::InvalidRow {
            table: "events",
            column: "value",
            value: error.to_string(),
        })?,
    );
    Ok(value)
}

/// Decodes one event value. `row_id` is backend-defined and this backend writes none.
pub(crate) fn decode_event(value: &[u8]) -> Result<EventRecord, StorageError> {
    let body = encoding::body("events", value)?;
    let mut record: EventRecord =
        serde_json::from_slice(body).map_err(|error| StorageError::InvalidRow {
            table: "events",
            column: "value",
            value: error.to_string(),
        })?;
    record.row_id = None;
    Ok(record)
}

/// Decodes one event value's fixed header, without its JSON body.
pub(crate) fn event_header(value: &[u8]) -> Result<EventHeader, StorageError> {
    encoding::event_header("events", value)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use nostream_core::Event;

    fn event() -> Event {
        serde_json::from_value(serde_json::json!({
            "id": "0d684e8ec2431de586aa3cafbee2f6d308d19b28805e53deabcac3220e9136a5",
            "pubkey": "f43c1f9bff677b8f27b602725ea0ad51af221344f69a6b352a74991a4479bac3",
            "created_at": 1660407625i64,
            "kind": 3,
            "tags": [["p", "b34417513f66497d7b0e1a8406b6689ac32afb184027717e57d281ea19186315"]],
            "content": "hello",
            "sig": "ab".repeat(64)
        }))
        .expect("a wire event")
    }

    #[test]
    fn the_header_carries_the_live_state_without_decoding_the_body() {
        let mut record = EventRecord::from_event(&event()).with_expires_at(2_000_000_000);
        record.deleted_at = Some(DateTime::UNIX_EPOCH);
        let value = encode_event(&record).expect("an encoded event");
        let header = event_header(&value).expect("a header");
        assert!(header.deleted);
        assert_eq!(header.expires_at, Some(2_000_000_000));
        assert_eq!(header.created_at, 1_660_407_625);
        assert_eq!(header.kind, 3);
        assert_eq!(header.pubkey, record.event.pubkey);
    }

    #[test]
    fn a_value_without_a_body_is_an_invalid_row() {
        let mut value = Vec::from([ROW_FORMAT_VERSION]);
        value.extend_from_slice(&[0u8; EVENT_HEADER_LEN]);
        let error = decode_event(&value).expect_err("no body");
        assert!(matches!(error, StorageError::InvalidRow { .. }));
    }

    #[test]
    fn a_tail_row_round_trips_behind_the_version_byte() {
        let user = StoredUser::new(event().pubkey, DateTime::UNIX_EPOCH);
        let value = encode("users", &user).expect("an encoded user");
        assert_eq!(value[0], ROW_FORMAT_VERSION);
        let decoded: StoredUser = decode("users", &value).expect("a decoded user");
        assert_eq!(decoded.pubkey, user.pubkey);
        assert!(!decoded.is_admitted);
    }

    #[test]
    fn a_bumped_version_is_refused_by_every_row_type() {
        let user = StoredUser::new(event().pubkey, DateTime::UNIX_EPOCH);
        let mut value = encode("users", &user).expect("an encoded user");
        value[0] = 2;
        let error = decode::<StoredUser>("users", &value).expect_err("version 2");
        match error {
            StorageError::InvalidRow { value, .. } => {
                assert_eq!(value, "unsupported format version 2");
            }
            other => panic!("expected InvalidRow, got {other:?}"),
        }
    }
}
