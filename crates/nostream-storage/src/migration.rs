//! The Postgres-to-LMDB migration seam.
//!
//! This module exists for one caller — `nostream-cli migrate pg-to-lmdb` — and is **not** a
//! general read or write surface. Nothing in the relay, the daemon or the repository traits may
//! use it, and a second caller needs a decision record first
//! (`docs/rewrite/decisions/0012-pg-to-lmdb-migration.md`, D1).
//!
//! It lives here rather than in the CLI because the pieces a copy needs are in this crate: the
//! Postgres row decoders (`crate::postgres::rows`), the event column list, and the LMDB
//! per-table write paths with their index entries. A CLI-side copy would restate nine column
//! lists and nine index write paths and drift from them.
//!
//! The seam is two traits and the rows they move. [`MigrationSource`] reads a table one keyset
//! page at a time with no filter of any kind; [`MigrationTarget`] writes a page exactly as the
//! source carries it and reads a page back for the verification pass. Neither goes through the
//! nine repository traits: no trait enumerates a table, and every trait write stamps, clears or
//! drops at least one column, so a trait-shaped copy would be both lossy and partial.
//!
//! Every type here compiles with no driver. The two implementations are `#[cfg(feature)]`, and
//! this vocabulary must stay buildable with neither.

use chrono::{DateTime, Utc};

use crate::error::StorageError;
use crate::repositories::{
    DeliveryLogEntry, DvmJob, EventRecord, InviteCode, Invoice, Nip05Verification, OutboxMessage,
    Report, StorageFuture, User,
};

/// One table the migration moves, in the order the copy walks them.
///
/// The nine are the tables the store has a repository and a database for. Two of the capture's
/// ten repository tables are not here: `event_tags`, whose LMDB `tags` database the event write
/// path maintains itself, and `user_subscriptions`, which has no trait and no database
/// (`MigratedTable::NOT_MIGRATED` records both).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum MigratedTable {
    DvmJobs,
    Events,
    InviteCodes,
    Invoices,
    Nip05Verifications,
    NotificationDeliveryLog,
    NotificationOutbox,
    Reports,
    Users,
}

impl MigratedTable {
    /// Every table, in the order the copy walks them.
    pub const ALL: [Self; 9] = [
        Self::DvmJobs,
        Self::Events,
        Self::InviteCodes,
        Self::Invoices,
        Self::Nip05Verifications,
        Self::NotificationDeliveryLog,
        Self::NotificationOutbox,
        Self::Reports,
        Self::Users,
    ];

    /// The source tables this tool does not move, which the manifest prints as a stated limit.
    pub const NOT_MIGRATED: [&'static str; 2] = ["event_tags", "user_subscriptions"];

    /// The table's name, spelled as Postgres and the manifest spell it.
    pub const fn name(self) -> &'static str {
        match self {
            Self::DvmJobs => "dvm_jobs",
            Self::Events => "events",
            Self::InviteCodes => "invite_codes",
            Self::Invoices => "invoices",
            Self::Nip05Verifications => "nip05_verifications",
            Self::NotificationDeliveryLog => "notification_delivery_log",
            Self::NotificationOutbox => "notification_outbox",
            Self::Reports => "reports",
            Self::Users => "users",
        }
    }
}

/// A `users` row with the one column the seam's [`User`] omits.
///
/// `fromDBUser` drops `tos_accepted_at` from the read shape (`src/utils/transform.ts:137-144`),
/// so no trait write can carry an operator's terms-of-service record; the migration does.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MigratedUser {
    pub user: User,
    /// `users.tos_accepted_at`.
    pub tos_accepted_at: Option<DateTime<Utc>>,
}

/// One row of one table, as the migration moves it.
///
/// One tuple variant per table, so a row is built as `MigrationRow::Report(Report { .. })` and
/// never as a struct variant; the variant tag is part of the canonical bytes.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum MigrationRow {
    DvmJob(DvmJob),
    Event(EventRecord),
    InviteCode(InviteCode),
    Invoice(Invoice),
    Nip05Verification(Nip05Verification),
    DeliveryLogEntry(DeliveryLogEntry),
    OutboxMessage(OutboxMessage),
    Report(Report),
    User(MigratedUser),
}

impl MigrationRow {
    /// The table this row belongs to.
    pub const fn table(&self) -> MigratedTable {
        match self {
            Self::DvmJob(_) => MigratedTable::DvmJobs,
            Self::Event(_) => MigratedTable::Events,
            Self::InviteCode(_) => MigratedTable::InviteCodes,
            Self::Invoice(_) => MigratedTable::Invoices,
            Self::Nip05Verification(_) => MigratedTable::Nip05Verifications,
            Self::DeliveryLogEntry(_) => MigratedTable::NotificationDeliveryLog,
            Self::OutboxMessage(_) => MigratedTable::NotificationOutbox,
            Self::Report(_) => MigratedTable::Reports,
            Self::User(_) => MigratedTable::Users,
        }
    }

    /// The row's key, in the byte form the LMDB database it belongs to is written under: the
    /// 32 raw bytes of an id or a pubkey, the UTF-8 bytes of a text key, and the flip-signed
    /// `i32` of `reports.id`.
    pub fn key(&self) -> Vec<u8> {
        match self {
            Self::DvmJob(job) => job.id.as_bytes().to_vec(),
            Self::Event(record) => record.event.id.as_bytes().to_vec(),
            Self::InviteCode(invite) => invite.code.as_bytes().to_vec(),
            Self::Invoice(invoice) => invoice.id.as_bytes().to_vec(),
            Self::Nip05Verification(verification) => verification.pubkey.as_bytes().to_vec(),
            Self::DeliveryLogEntry(entry) => entry.id.as_bytes().to_vec(),
            Self::OutboxMessage(message) => message.id.as_bytes().to_vec(),
            Self::Report(report) => report_key(report.id).to_vec(),
            Self::User(user) => user.user.pubkey.as_bytes().to_vec(),
        }
    }

    /// The row's canonical bytes: `serde_json` of the row with the two normalisations applied
    /// that make a source row and the same row read back from the store project identically.
    ///
    /// [`EventRecord::row_id`] is set to `None` — it is the one column that is not stored
    /// (`crate::lmdb::rows` sets it to `None` on every read) — and every instant is truncated
    /// to the microsecond precision a PostgreSQL `timestamp` column has.
    pub fn canonical(&self) -> Result<Vec<u8>, StorageError> {
        serde_json::to_vec(&self.normalised()).map_err(|error| StorageError::InvalidRow {
            table: self.table().name(),
            column: "value",
            value: error.to_string(),
        })
    }

    /// The row as the target stores it and as [`canonical`](Self::canonical) digests it.
    pub(crate) fn normalised(&self) -> Self {
        match self {
            Self::DvmJob(job) => Self::DvmJob(DvmJob {
                picked_up_at: job.picked_up_at.map(micros),
                completed_at: job.completed_at.map(micros),
                created_at: micros(job.created_at),
                updated_at: micros(job.updated_at),
                ..job.clone()
            }),
            Self::Event(record) => Self::Event(EventRecord {
                row_id: None,
                first_seen: record.first_seen.map(micros),
                deleted_at: record.deleted_at.map(micros),
                ..record.clone()
            }),
            Self::InviteCode(invite) => Self::InviteCode(InviteCode {
                expires_at: invite.expires_at.map(micros),
                created_at: micros(invite.created_at),
                updated_at: micros(invite.updated_at),
                ..invite.clone()
            }),
            Self::Invoice(invoice) => Self::Invoice(Invoice {
                confirmed_at: invoice.confirmed_at.map(micros),
                expires_at: invoice.expires_at.map(micros),
                updated_at: micros(invoice.updated_at),
                created_at: micros(invoice.created_at),
                ..invoice.clone()
            }),
            Self::Nip05Verification(verification) => Self::Nip05Verification(Nip05Verification {
                last_verified_at: verification.last_verified_at.map(micros),
                last_checked_at: micros(verification.last_checked_at),
                created_at: micros(verification.created_at),
                updated_at: micros(verification.updated_at),
                ..verification.clone()
            }),
            Self::DeliveryLogEntry(entry) => Self::DeliveryLogEntry(DeliveryLogEntry {
                created_at: micros(entry.created_at),
                ..entry.clone()
            }),
            Self::OutboxMessage(message) => Self::OutboxMessage(OutboxMessage {
                available_at: micros(message.available_at),
                delivered_at: message.delivered_at.map(micros),
                created_at: micros(message.created_at),
                updated_at: micros(message.updated_at),
                ..message.clone()
            }),
            Self::Report(report) => Self::Report(Report {
                created_at: micros(report.created_at),
                ..report.clone()
            }),
            Self::User(user) => Self::User(MigratedUser {
                user: User {
                    created_at: micros(user.user.created_at),
                    updated_at: micros(user.user.updated_at),
                    ..user.user.clone()
                },
                tos_accepted_at: user.tos_accepted_at.map(micros),
            }),
        }
    }
}

/// Reads one table of the source, a keyset page at a time.
///
/// The implementation issues no statement but these reads: the migration never writes to the
/// source (`docs/rewrite/decisions/0012-pg-to-lmdb-migration.md`, D12).
pub trait MigrationSource: Send + Sync {
    /// The rows of `table` after `after`, in the table's key order, at most `limit` of them.
    ///
    /// `after` is exclusive and `None` starts at the table's first row. A page shorter than
    /// `limit` means the table has no more rows.
    fn read_batch<'a>(
        &'a self,
        table: MigratedTable,
        after: Option<&'a [u8]>,
        limit: usize,
    ) -> StorageFuture<'a, Vec<MigrationRow>>;
}

/// Writes one page of the source's rows into the store, and reads a page back.
pub trait MigrationTarget: Send + Sync {
    /// Writes every row in `rows`, which all belong to one table, in one transaction, and
    /// answers how many rows it wrote.
    fn write_batch<'a>(&'a self, rows: &'a [MigrationRow]) -> StorageFuture<'a, u64>;

    /// The rows of `table` after `after`, in the store's key order, at most `limit` of them.
    ///
    /// This is the read the verification pass folds: it takes the rows a copy would have
    /// written, not the rows a repository read would return.
    fn scan_batch<'a>(
        &'a self,
        table: MigratedTable,
        after: Option<&'a [u8]>,
        limit: usize,
    ) -> StorageFuture<'a, Vec<MigrationRow>>;
}

/// The instant at the microsecond precision every PostgreSQL `timestamp` column has.
///
/// The store's value codec truncates the same way (`lmdb::encoding::micros`); this module
/// restates it because it has to compile with no driver.
fn micros(value: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp_micros(value.timestamp_micros()).unwrap_or(value)
}

/// The `reports.id` key: an `i32` ordered by its bytes, the sign bit flipped so a negative value
/// sorts before zero.
///
/// The store's `lmdb::encoding::i32_key`, restated for the same reason as [`micros`].
fn report_key(id: i32) -> [u8; 4] {
    ((id as u32) ^ (1 << 31)).to_be_bytes()
}
