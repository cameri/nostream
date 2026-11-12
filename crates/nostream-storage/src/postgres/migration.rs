//! `MigrationSource` against Postgres: one keyset statement per table, decoded by the
//! backend's own row decoders.
//!
//! Every statement reads a whole table. It carries no filter of any kind, because the trait
//! reads cannot see the rows a migration has to move: `find_by_filters` adds
//! `deleted_at IS NULL AND (expires_at IS NULL OR expires_at > $now)`, so a soft-deleted or
//! expired event is unreachable through it, and no trait read enumerates a table at all.
//!
//! Nothing here writes. The migration issues no `INSERT`, `UPDATE`, `DELETE` or DDL against the
//! source, and never runs the embedded migrator: a source that has not been migrated fails with
//! the driver's own error (`docs/rewrite/decisions/0012-pg-to-lmdb-migration.md`, D12).

use sqlx::Row;
use sqlx::postgres::PgRow;

use super::invoices::INVOICE_COLUMNS;
use super::metadata::{DVM_COLUMNS, INVITE_COLUMNS, NIP05_COLUMNS, REPORT_COLUMNS};
use super::notifications::{DELIVERY_LOG_COLUMNS, OUTBOX_COLUMNS};
use super::sql::EVENT_COLUMNS;
use super::{Arg, Args, EventQuery, PostgresBackend, rows};
use crate::error::StorageError;
use crate::migration::{MigratedTable, MigratedUser, MigrationRow, MigrationSource};
use crate::repositories::StorageFuture;

/// `users` columns: [`super::users::find_by_pubkey`]'s list plus `tos_accepted_at`, which the
/// seam's [`crate::repositories::User`] omits and a migration still has to carry.
const USER_COLUMNS: &str = "pubkey, COALESCE(is_admitted, false) AS is_admitted, \
COALESCE(is_vanished, false) AS is_vanished, COALESCE(balance, 0) AS balance, created_at, \
updated_at, tos_accepted_at";

impl MigrationSource for PostgresBackend {
    fn read_batch<'a>(
        &'a self,
        table: MigratedTable,
        after: Option<&'a [u8]>,
        limit: usize,
    ) -> StorageFuture<'a, Vec<MigrationRow>> {
        Box::pin(async move {
            let (sql, args) = statement(table, after, limit)?;
            let rows = EventQuery { sql, args }
                .into_query()
                .fetch_all(self.master())
                .await?;
            decode(table, &rows)
        })
    }
}

/// How a table's unique key is bound as a keyset cursor.
///
/// Each variant is the *column's* type, read from `migrations/`, not the shape the key looks
/// like: `invoices.id` began as a `uuid` and was changed to `text`
/// (`migrations/20230205004400_change_invoice_id_to_string.sql:1`), so a `::uuid` cast against
/// it is rejected by the server on the second page. The table below is the audit.
///
/// | table | column | type |
/// |---|---|---|
/// | `dvm_jobs` | `id` | `bytea` |
/// | `events` | `event_id` | `bytea` |
/// | `invite_codes` | `code` | `varchar(64)` |
/// | `invoices` | `id` | `text` |
/// | `nip05_verifications` | `pubkey` | `bytea` |
/// | `notification_delivery_log` | `id` | `uuid` |
/// | `notification_outbox` | `id` | `uuid` |
/// | `reports` | `id` | `serial` (`i32`) |
/// | `users` | `pubkey` | `bytea` |
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cursor {
    /// A `bytea` key: the row's key bytes are the column's value.
    Bytes,
    /// A `uuid` key: the row's key bytes are its canonical text, cast back to the column's type.
    Uuid,
    /// A `text`/`varchar` key: the row's key bytes are the column's value.
    Text,
    /// `reports.id`: the row's key is [`crate::migration::MigrationRow::key`]'s flip-signed
    /// `i32`, which the column holds unflipped.
    Int32Key,
}

/// `SELECT <columns> FROM <table> [WHERE <key> > $1] ORDER BY <key> LIMIT $n`.
///
/// The cursor is the table's unique key, which is what makes the paging stable across a resume:
/// the copy's own `after` is that key in exactly this form.
fn statement(
    table: MigratedTable,
    after: Option<&[u8]>,
    limit: usize,
) -> Result<(String, Args), StorageError> {
    let (columns, key, cursor) = match table {
        MigratedTable::DvmJobs => (DVM_COLUMNS, "id", Cursor::Bytes),
        MigratedTable::Events => (EVENT_COLUMNS, "event_id", Cursor::Bytes),
        MigratedTable::InviteCodes => (INVITE_COLUMNS, "code", Cursor::Text),
        // `text`, not `uuid`: `20230205004400_change_invoice_id_to_string.sql` altered it.
        MigratedTable::Invoices => (INVOICE_COLUMNS, "id", Cursor::Text),
        MigratedTable::Nip05Verifications => (NIP05_COLUMNS, "pubkey", Cursor::Bytes),
        MigratedTable::NotificationDeliveryLog => (DELIVERY_LOG_COLUMNS, "id", Cursor::Uuid),
        MigratedTable::NotificationOutbox => (OUTBOX_COLUMNS, "id", Cursor::Uuid),
        MigratedTable::Reports => (REPORT_COLUMNS, "id", Cursor::Int32Key),
        MigratedTable::Users => (USER_COLUMNS, "pubkey", Cursor::Bytes),
    };

    let mut args = Args::default();
    let filter = match after {
        None => String::new(),
        Some(after) => {
            let comparison = match cursor {
                Cursor::Bytes => {
                    let slot = args.push(Arg::Bytes(after.to_vec()));
                    format!("{key} > {slot}")
                }
                Cursor::Uuid => {
                    let slot = args.push(Arg::Text(text(table, after)?));
                    // An explicit cast: the bound value is text, the column is `uuid`.
                    format!("{key} > {slot}::uuid")
                }
                Cursor::Text => {
                    let slot = args.push(Arg::Text(text(table, after)?));
                    format!("{key} > {slot}")
                }
                Cursor::Int32Key => {
                    let slot = args.push(Arg::Int(int32_key(table, after)?));
                    format!("{key} > {slot}")
                }
            };
            format!(" WHERE {comparison}")
        }
    };
    let limit_slot = args.push(Arg::BigInt(i64::try_from(limit).unwrap_or(i64::MAX)));
    let table_name = table.name();

    Ok((
        format!("SELECT {columns} FROM {table_name} {filter} ORDER BY {key} LIMIT {limit_slot}"),
        args,
    ))
}

/// One cursor as the text a `uuid`, `text` or `varchar` column holds.
fn text(table: MigratedTable, after: &[u8]) -> Result<String, StorageError> {
    std::str::from_utf8(after)
        .map(str::to_owned)
        .map_err(|_| StorageError::InvalidRow {
            table: table.name(),
            column: "key",
            value: "the resume cursor is not utf-8".to_owned(),
        })
}

/// One cursor as the `i32` `reports.id` holds, through the shared key codec.
fn int32_key(table: MigratedTable, after: &[u8]) -> Result<i32, StorageError> {
    crate::keys::i32_from_key(after).ok_or_else(|| StorageError::InvalidRow {
        table: table.name(),
        column: "key",
        value: format!("{} bytes are not a reports key", after.len()),
    })
}

/// One page of rows, through the decoder the backend already has for that table.
fn decode(table: MigratedTable, rows: &[PgRow]) -> Result<Vec<MigrationRow>, StorageError> {
    match table {
        MigratedTable::DvmJobs => rows
            .iter()
            .map(|row| rows::dvm_job(row).map(MigrationRow::DvmJob))
            .collect(),
        MigratedTable::Events => rows
            .iter()
            .map(|row| rows::event_record(row).map(MigrationRow::Event))
            .collect(),
        MigratedTable::InviteCodes => rows
            .iter()
            .map(|row| rows::invite_code(row).map(MigrationRow::InviteCode))
            .collect(),
        MigratedTable::Invoices => rows
            .iter()
            .map(|row| rows::invoice(row).map(MigrationRow::Invoice))
            .collect(),
        MigratedTable::Nip05Verifications => rows
            .iter()
            .map(|row| rows::nip05_verification(row).map(MigrationRow::Nip05Verification))
            .collect(),
        MigratedTable::NotificationDeliveryLog => rows
            .iter()
            .map(|row| rows::delivery_log_entry(row).map(MigrationRow::DeliveryLogEntry))
            .collect(),
        MigratedTable::NotificationOutbox => rows
            .iter()
            .map(|row| rows::outbox_message(row).map(MigrationRow::OutboxMessage))
            .collect(),
        MigratedTable::Reports => rows
            .iter()
            .map(|row| rows::report(row).map(MigrationRow::Report))
            .collect(),
        MigratedTable::Users => rows.iter().map(user).collect(),
    }
}

/// One user row: [`rows::user`] plus the column the seam's read shape drops.
fn user(row: &PgRow) -> Result<MigrationRow, StorageError> {
    let tos_accepted_at: Option<chrono::NaiveDateTime> = row.try_get("tos_accepted_at")?;
    Ok(MigrationRow::User(MigratedUser {
        user: rows::user(row)?,
        tos_accepted_at: tos_accepted_at.map(crate::records::utc_from_naive),
    }))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    /// The statement one table composes when paging from `after`.
    fn sql(table: MigratedTable, after: Option<&[u8]>) -> String {
        statement(table, after, 2)
            .expect("the statement composes")
            .0
    }

    #[test]
    fn the_first_page_of_every_table_binds_no_cursor() {
        for table in MigratedTable::ALL {
            let text = sql(table, None);
            assert!(
                !text.contains("WHERE"),
                "{} pages from the first row: {text}",
                table.name()
            );
            assert!(
                text.ends_with("LIMIT $1"),
                "{} binds its limit first: {text}",
                table.name()
            );
        }
    }

    /// `invoices.id` was a `uuid` until `20230205004400_change_invoice_id_to_string.sql` made it
    /// `text`; a `::uuid` cast on the cursor makes the second page a server-side type error.
    #[test]
    fn the_uuid_cursor_is_the_two_tables_the_schema_makes_uuid() {
        let uuid = b"00000000-0000-4000-8000-000000000001";

        let invoices = sql(MigratedTable::Invoices, Some(uuid));
        assert!(invoices.contains("id > $1"), "{invoices}");
        assert!(
            !invoices.contains("::uuid"),
            "invoices.id is text: {invoices}"
        );

        for table in [
            MigratedTable::NotificationDeliveryLog,
            MigratedTable::NotificationOutbox,
        ] {
            let text = sql(table, Some(uuid));
            assert!(
                text.contains("id > $1::uuid"),
                "{} pages on a uuid column: {text}",
                table.name()
            );
        }
    }

    #[test]
    fn every_cursor_is_the_tables_own_key() {
        assert!(sql(MigratedTable::Events, Some(&[7; 32])).contains("event_id > $1"));
        assert!(sql(MigratedTable::Users, Some(&[7; 32])).contains("pubkey > $1"));
        assert!(sql(MigratedTable::Nip05Verifications, Some(&[7; 32])).contains("pubkey > $1"));
        assert!(sql(MigratedTable::DvmJobs, Some(&[0; 32])).contains("id > $1"));
        assert!(sql(MigratedTable::InviteCodes, Some(b"code-1")).contains("code > $1"));
        assert!(sql(MigratedTable::Reports, Some(&[0x80, 0x00, 0x00, 0x02])).contains("id > $1"));
    }

    #[test]
    fn a_reports_cursor_is_undone_before_it_is_bound() {
        assert_eq!(
            int32_key(MigratedTable::Reports, &[0x80, 0x00, 0x00, 0x02]).unwrap(),
            2
        );
        assert_eq!(
            int32_key(MigratedTable::Reports, &[0x7f, 0xff, 0xff, 0xfd]).unwrap(),
            -3
        );
        assert!(int32_key(MigratedTable::Reports, &[0x80]).is_err());
    }
}
