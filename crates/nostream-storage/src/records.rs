//! Implementations for the row types declared in [`crate::repositories`]: constructors,
//! the enum spellings their columns hold, and the conversions the Postgres backend uses.
//! `repositories.rs` declares, this module implements.

use std::fmt;
use std::net::IpAddr;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use nostream_core::{Event, Kind};

use crate::error::StorageError;
use crate::repositories::{
    DvmJobStatus, EventRecord, FieldUpdate, InvoiceStatus, InvoiceUnit, NotificationDeliveryStatus,
    NotificationTargetType, OutboxStatus, ReportType,
};

// `#[derive(Default)]` would require `T: Default`, which a `FieldUpdate<DateTime<Utc>>` is
// not; the absent variant is the default for every `T`.
#[allow(clippy::derivable_impls)]
impl<T> Default for FieldUpdate<T> {
    fn default() -> Self {
        Self::Absent
    }
}

impl EventRecord {
    /// Wraps a wire event as a row to write: the four storage-only fields are empty and the
    /// backend applies its column defaults.
    pub fn from_event(event: &Event) -> Self {
        Self {
            row_id: None,
            event: event.clone(),
            first_seen: None,
            deleted_at: None,
            expires_at: None,
            event_deduplication: None,
            remote_address: None,
        }
    }

    /// Sets `events.remote_address` (the capture's `ContextMetadataKey`).
    pub fn with_remote_address(mut self, address: IpAddr) -> Self {
        self.remote_address = Some(address);
        self
    }

    /// Sets `events.expires_at` (the capture's `EventExpirationTimeMetadataKey`).
    pub fn with_expires_at(mut self, expires_at: i64) -> Self {
        self.expires_at = Some(expires_at);
        self
    }

    /// Sets `events.event_deduplication` (the capture's `EventDeduplicationMetadataKey`).
    pub fn with_deduplication(mut self, deduplication: Vec<serde_json::Value>) -> Self {
        self.event_deduplication = Some(deduplication);
        self
    }

    /// The `event_deduplication` value an insert writes: the record's own, or the capture's
    /// default of `[pubkey, kind]` with the kind as a JSON number.
    pub fn deduplication(&self) -> Vec<serde_json::Value> {
        self.event_deduplication
            .clone()
            .unwrap_or_else(|| default_deduplication(&self.event))
    }
}

/// `jsonb_build_array(pubkey, kind)` as `src/repositories/event-repository.ts:390-396`
/// builds it: the pubkey hex string and the kind as a JSON number.
pub fn default_deduplication(event: &Event) -> Vec<serde_json::Value> {
    vec![
        serde_json::Value::String(event.pubkey.to_string()),
        serde_json::Value::Number(serde_json::Number::from(event.kind.0)),
    ]
}

/// Implements the one lowercase spelling a column holds, its parser (an unknown value is
/// [`StorageError::InvalidRow`], never a default) and `Display`.
macro_rules! column_enum {
    ($type:ident { $($variant:ident => $spelling:literal),+ $(,)? } table $table:literal, column $column:literal) => {
        impl $type {
            /// The value the column stores.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $spelling),+
                }
            }

            /// Parses a column value; an unknown spelling is an invalid row, never a default.
            pub fn parse(value: &str) -> Result<Self, StorageError> {
                match value {
                    $($spelling => Ok(Self::$variant),)+
                    other => Err(StorageError::InvalidRow {
                        table: $table,
                        column: $column,
                        value: other.to_owned(),
                    }),
                }
            }
        }

        impl fmt::Display for $type {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }

        impl FromStr for $type {
            type Err = StorageError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::parse(value)
            }
        }
    };
}

column_enum!(InvoiceUnit {
    Msats => "msats",
    Sats => "sats",
    Btc => "btc",
} table "invoices", column "unit");

column_enum!(InvoiceStatus {
    Pending => "pending",
    Completed => "completed",
    Expired => "expired",
} table "invoices", column "status");

column_enum!(DvmJobStatus {
    Submitted => "submitted",
    PickedUp => "picked_up",
    Completed => "completed",
    Failed => "failed",
    TimedOut => "timed_out",
} table "dvm_jobs", column "status");

column_enum!(ReportType {
    Nudity => "nudity",
    Malware => "malware",
    Profanity => "profanity",
    Illegal => "illegal",
    Spam => "spam",
    Impersonation => "impersonation",
    Other => "other",
} table "reports", column "report_type");

column_enum!(NotificationTargetType {
    Http => "http",
    Discord => "discord",
    Slack => "slack",
    Telegram => "telegram",
} table "notification_delivery_log", column "target_type");

column_enum!(NotificationDeliveryStatus {
    Success => "success",
    Failed => "failed",
} table "notification_delivery_log", column "status");

column_enum!(OutboxStatus {
    Pending => "pending",
    Processing => "processing",
    Delivered => "delivered",
    Dead => "dead",
} table "notification_outbox", column "status");

impl DvmJobStatus {
    /// Whether the status closes the job (`src/repositories/dvm-job-repository.ts`
    /// `isTerminal`), which sets `completed_at`.
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::TimedOut)
    }

    /// Whether the job is still waiting for or running on a worker (`findPendingJobs`).
    pub const fn is_pending(self) -> bool {
        matches!(self, Self::Submitted | Self::PickedUp)
    }
}

/// The report arm parses NIP-56's seven types, so the mapping is total by construction and
/// never needs a default.
impl From<nostream_core::nip56::ReportType> for ReportType {
    fn from(report_type: nostream_core::nip56::ReportType) -> Self {
        match report_type {
            nostream_core::nip56::ReportType::Nudity => Self::Nudity,
            nostream_core::nip56::ReportType::Malware => Self::Malware,
            nostream_core::nip56::ReportType::Profanity => Self::Profanity,
            nostream_core::nip56::ReportType::Illegal => Self::Illegal,
            nostream_core::nip56::ReportType::Spam => Self::Spam,
            nostream_core::nip56::ReportType::Impersonation => Self::Impersonation,
            nostream_core::nip56::ReportType::Other => Self::Other,
        }
    }
}

/// The integer columns are `integer`; a value outside `i32` cannot come from them, and a
/// negative one cannot name a kind or a creation time.
pub fn kind_from_i32(value: i32) -> Result<Kind, StorageError> {
    u64::try_from(value)
        .map(Kind)
        .map_err(|_| StorageError::ValueOutOfRange {
            column: "event_kind",
            value: value.to_string(),
        })
}

/// A `timestamp` column decoded as UTC. Every connection sets `timezone=UTC`, and the
/// capture's writes go through `now()` on a UTC session, so the value is a UTC instant.
pub fn utc_from_naive(value: chrono::NaiveDateTime) -> DateTime<Utc> {
    value.and_utc()
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
        .expect("the fixture event is a wire event")
    }

    #[test]
    fn a_record_from_an_event_has_no_storage_state() {
        let record = EventRecord::from_event(&event());
        assert_eq!(record.event, event());
        assert!(record.row_id.is_none());
        assert!(record.first_seen.is_none());
        assert!(record.deleted_at.is_none());
        assert!(record.expires_at.is_none());
        assert!(record.event_deduplication.is_none());
        assert!(record.remote_address.is_none());
    }

    #[test]
    fn the_builders_set_the_four_storage_only_fields() {
        let record = EventRecord::from_event(&event())
            .with_remote_address("203.0.113.7".parse().expect("an address"))
            .with_expires_at(1_700_000_000)
            .with_deduplication(vec![serde_json::json!("tag-value")]);
        assert_eq!(
            record.remote_address,
            Some("203.0.113.7".parse().expect("an address"))
        );
        assert_eq!(record.expires_at, Some(1_700_000_000));
        assert_eq!(
            record.event_deduplication,
            Some(vec![serde_json::json!("tag-value")])
        );
    }

    #[test]
    fn the_default_deduplication_is_the_pubkey_and_the_kind() {
        let deduplication = default_deduplication(&event());
        assert_eq!(
            deduplication,
            vec![
                serde_json::json!(
                    "f43c1f9bff677b8f27b602725ea0ad51af221344f69a6b352a74991a4479bac3"
                ),
                serde_json::json!(3),
            ]
        );
        assert!(deduplication[1].is_number());
    }

    #[test]
    fn a_record_without_deduplication_reports_the_default() {
        let record = EventRecord::from_event(&event());
        assert_eq!(record.deduplication(), default_deduplication(&event()));
    }

    #[test]
    fn a_record_with_deduplication_reports_its_own() {
        let record = EventRecord::from_event(&event())
            .with_deduplication(vec![serde_json::json!("0d684e8ec2431de5")]);
        assert_eq!(
            record.deduplication(),
            vec![serde_json::json!("0d684e8ec2431de5")]
        );
    }

    #[test]
    fn a_parsed_report_type_maps_to_the_column_spelling() {
        use nostream_core::nip56::ReportType as Parsed;

        let cases = [
            (Parsed::Nudity, "nudity"),
            (Parsed::Malware, "malware"),
            (Parsed::Profanity, "profanity"),
            (Parsed::Illegal, "illegal"),
            (Parsed::Spam, "spam"),
            (Parsed::Impersonation, "impersonation"),
            (Parsed::Other, "other"),
        ];

        for (parsed, spelling) in cases {
            assert_eq!(ReportType::from(parsed).as_str(), spelling);
            assert_eq!(parsed.as_str(), spelling);
        }
    }

    #[test]
    fn every_column_enum_round_trips_its_spelling() {
        let cases: Vec<(&str, &str)> = vec![
            (InvoiceUnit::Msats.as_str(), "msats"),
            (InvoiceUnit::Sats.as_str(), "sats"),
            (InvoiceUnit::Btc.as_str(), "btc"),
            (InvoiceStatus::Pending.as_str(), "pending"),
            (InvoiceStatus::Completed.as_str(), "completed"),
            (InvoiceStatus::Expired.as_str(), "expired"),
            (DvmJobStatus::Submitted.as_str(), "submitted"),
            (DvmJobStatus::PickedUp.as_str(), "picked_up"),
            (DvmJobStatus::Completed.as_str(), "completed"),
            (DvmJobStatus::Failed.as_str(), "failed"),
            (DvmJobStatus::TimedOut.as_str(), "timed_out"),
            (ReportType::Nudity.as_str(), "nudity"),
            (ReportType::Malware.as_str(), "malware"),
            (ReportType::Profanity.as_str(), "profanity"),
            (ReportType::Illegal.as_str(), "illegal"),
            (ReportType::Spam.as_str(), "spam"),
            (ReportType::Impersonation.as_str(), "impersonation"),
            (ReportType::Other.as_str(), "other"),
            (NotificationTargetType::Http.as_str(), "http"),
            (NotificationTargetType::Discord.as_str(), "discord"),
            (NotificationTargetType::Slack.as_str(), "slack"),
            (NotificationTargetType::Telegram.as_str(), "telegram"),
            (NotificationDeliveryStatus::Success.as_str(), "success"),
            (NotificationDeliveryStatus::Failed.as_str(), "failed"),
            (OutboxStatus::Pending.as_str(), "pending"),
            (OutboxStatus::Processing.as_str(), "processing"),
            (OutboxStatus::Delivered.as_str(), "delivered"),
            (OutboxStatus::Dead.as_str(), "dead"),
        ];
        for (spelling, expected) in cases {
            assert_eq!(spelling, expected);
        }

        assert_eq!(
            "msats".parse::<InvoiceUnit>().expect("msats"),
            InvoiceUnit::Msats
        );
        assert_eq!(
            "timed_out".parse::<DvmJobStatus>().expect("timed_out"),
            DvmJobStatus::TimedOut
        );
        assert_eq!(
            "impersonation"
                .parse::<ReportType>()
                .expect("impersonation"),
            ReportType::Impersonation
        );
        assert_eq!(
            "telegram"
                .parse::<NotificationTargetType>()
                .expect("telegram"),
            NotificationTargetType::Telegram
        );
        assert_eq!(
            "dead".parse::<OutboxStatus>().expect("dead"),
            OutboxStatus::Dead
        );
        assert_eq!(InvoiceStatus::Expired.to_string(), "expired");
    }

    #[test]
    fn an_unknown_column_value_is_an_invalid_row() {
        let error = "Telegram"
            .parse::<NotificationTargetType>()
            .expect_err("case matters");
        match error {
            StorageError::InvalidRow {
                table,
                column,
                value,
            } => {
                assert_eq!(table, "notification_delivery_log");
                assert_eq!(column, "target_type");
                assert_eq!(value, "Telegram");
            }
            other => panic!("expected InvalidRow, got {other:?}"),
        }
    }

    #[test]
    fn a_terminal_dvm_status_closes_the_job() {
        assert!(DvmJobStatus::Completed.is_terminal());
        assert!(DvmJobStatus::Failed.is_terminal());
        assert!(DvmJobStatus::TimedOut.is_terminal());
        assert!(!DvmJobStatus::PickedUp.is_terminal());
        assert!(DvmJobStatus::PickedUp.is_pending());
        assert!(!DvmJobStatus::Submitted.is_terminal());
    }

    #[test]
    fn a_kind_comes_from_a_non_negative_integer() {
        assert_eq!(kind_from_i32(1).expect("kind 1"), Kind::TEXT_NOTE);
        let error = kind_from_i32(-1).expect_err("negative kinds do not exist");
        assert!(matches!(error, StorageError::ValueOutOfRange { .. }));
    }

    #[test]
    fn field_update_defaults_to_absent() {
        assert_eq!(FieldUpdate::<i32>::default(), FieldUpdate::Absent);
    }
}
