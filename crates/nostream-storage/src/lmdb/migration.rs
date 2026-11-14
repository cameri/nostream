//! `MigrationTarget` against LMDB: one write transaction per batch, one migration-only writer
//! per table.
//!
//! Every writer puts the source's own key and value and the index entries that table's existing
//! write path writes, and stamps, clears and defaults nothing. That is what makes a replayed
//! batch idempotent: the same row written twice is a put of the same key with the same value.
//!
//! What each writer is handed is the row's normalised form ([`MigrationRow::normalised`]), so
//! every instant is at the microsecond precision the value codec stores, and an event's
//! `row_id` — the one column the store does not keep — is already `None`.

use heed::types::Bytes;
use heed::{Database, RoTxn, RwTxn};

use super::rows::StoredUser;
use super::{Databases, LmdbBackend, encoding, events, invoices, metadata, notifications, rows};
use crate::error::StorageError;
use crate::migration::{MigratedTable, MigratedUser, MigrationRow, MigrationTarget};
use crate::repositories::StorageFuture;

impl MigrationTarget for LmdbBackend {
    fn write_batch<'a>(&'a self, rows: &'a [MigrationRow]) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let Some(first) = rows.first() else {
                return Ok(0);
            };
            let table = first.table();
            if rows.iter().any(|row| row.table() != table) {
                return Err(StorageError::InvalidArgument {
                    message: "a migration batch must hold one table's rows",
                });
            }

            // The blocking closure owns what it touches, so the batch moves into it: one
            // transaction for the whole page, which either lands or does not.
            let batch = rows.to_vec();
            self.write(move |txn, databases| write_batch(txn, databases, &batch))
                .await?;
            Ok(rows.len() as u64)
        })
    }

    fn scan_batch<'a>(
        &'a self,
        table: MigratedTable,
        after: Option<&'a [u8]>,
        limit: usize,
    ) -> StorageFuture<'a, Vec<MigrationRow>> {
        Box::pin(async move {
            let after = after.map(<[u8]>::to_vec);
            self.read(move |txn, databases| scan(txn, databases, table, after.as_deref(), limit))
                .await
        })
    }
}

/// Writes one batch, and raises `meta`'s `reports.next_id` past the batch's largest report so a
/// later insert cannot collide with a migrated row.
fn write_batch(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    batch: &[MigrationRow],
) -> Result<(), StorageError> {
    let mut largest_report = 0;
    for row in batch {
        match row.normalised() {
            MigrationRow::DvmJob(job) => metadata::dvm_write(txn, databases, &job, None)?,
            MigrationRow::Event(record) => events::write_migrated(txn, databases, &record)?,
            MigrationRow::InviteCode(invite) => metadata::invite_write(txn, databases, &invite)?,
            MigrationRow::Invoice(invoice) => invoices::write(txn, databases, &invoice, None)?,
            MigrationRow::Nip05Verification(verification) => {
                metadata::nip05_write(txn, databases, &verification)?;
            }
            MigrationRow::DeliveryLogEntry(entry) => {
                notifications::delivery_write(txn, databases, &entry)?;
            }
            MigrationRow::OutboxMessage(message) => {
                notifications::outbox_write(txn, databases, &message, None)?;
            }
            MigrationRow::Report(report) => {
                metadata::report_write(txn, databases, &report)?;
                largest_report = largest_report.max(report.id);
            }
            MigrationRow::User(user) => {
                users_store(txn, databases, &user)?;
            }
        }
    }
    metadata::raise_report_sequence(txn, databases, largest_report)
}

/// Writes one `users` row: the whole [`StoredUser`], including the `tos_accepted_at` no trait
/// write carries.
fn users_store(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    migrated: &MigratedUser,
) -> Result<(), StorageError> {
    let user = &migrated.user;
    super::users::store(
        txn,
        databases,
        &StoredUser {
            pubkey: user.pubkey,
            is_admitted: user.is_admitted,
            is_vanished: user.is_vanished,
            balance: user.balance,
            tos_accepted_at: migrated.tos_accepted_at,
            created_at: user.created_at,
            updated_at: user.updated_at,
        },
    )
}

/// One page of a table, in the store's key order, resuming exclusively after `after`.
fn scan(
    txn: &RoTxn<'_>,
    databases: &Databases,
    table: MigratedTable,
    after: Option<&[u8]>,
    limit: usize,
) -> Result<Vec<MigrationRow>, StorageError> {
    let database = database(databases, table);
    let bounds = encoding::resume_bounds(after, b"", b"");
    let mut rows = Vec::new();
    for entry in database.range(txn, &bounds)? {
        if rows.len() >= limit {
            break;
        }
        let (_, value) = entry?;
        rows.push(decode(table, value)?);
    }
    Ok(rows)
}

/// The database one table's rows live in.
fn database(databases: &Databases, table: MigratedTable) -> Database<Bytes, Bytes> {
    match table {
        MigratedTable::DvmJobs => databases.dvm_jobs,
        MigratedTable::Events => databases.events,
        MigratedTable::InviteCodes => databases.invite_codes,
        MigratedTable::Invoices => databases.invoices,
        MigratedTable::Nip05Verifications => databases.nip05,
        MigratedTable::NotificationDeliveryLog => databases.notification_delivery_log,
        MigratedTable::NotificationOutbox => databases.outbox,
        MigratedTable::Reports => databases.reports,
        MigratedTable::Users => databases.users,
    }
}

/// One stored value, as the row the seam carries.
fn decode(table: MigratedTable, value: &[u8]) -> Result<MigrationRow, StorageError> {
    match table {
        MigratedTable::DvmJobs => rows::decode("dvm_jobs", value).map(MigrationRow::DvmJob),
        MigratedTable::Events => rows::decode_event(value).map(MigrationRow::Event),
        MigratedTable::InviteCodes => {
            rows::decode("invite_codes", value).map(MigrationRow::InviteCode)
        }
        MigratedTable::Invoices => rows::decode("invoices", value).map(MigrationRow::Invoice),
        MigratedTable::Nip05Verifications => {
            rows::decode("nip05_verifications", value).map(MigrationRow::Nip05Verification)
        }
        MigratedTable::NotificationDeliveryLog => {
            rows::decode("notification_delivery_log", value).map(MigrationRow::DeliveryLogEntry)
        }
        MigratedTable::NotificationOutbox => {
            rows::decode("notification_outbox", value).map(MigrationRow::OutboxMessage)
        }
        MigratedTable::Reports => rows::decode("reports", value).map(MigrationRow::Report),
        MigratedTable::Users => {
            let stored: StoredUser = rows::decode("users", value)?;
            let tos_accepted_at = stored.tos_accepted_at;
            Ok(MigrationRow::User(MigratedUser {
                user: stored.user(),
                tos_accepted_at,
            }))
        }
    }
}
