//! `InvoiceRepository` against Postgres. Mirrors `src/repositories/invoice-repository.ts`.

use chrono::{DateTime, Utc};
use sqlx::Executor;
use sqlx::postgres::Postgres;

use super::{Arg, Args, EventQuery};
use crate::error::StorageError;
use crate::repositories::{Invoice, InvoiceStatus};

const INVOICE_COLUMNS: &str = "id, pubkey, bolt11, amount_requested, amount_paid, unit, status, \
description, confirmed_at, expires_at, updated_at, created_at, verify_url";

/// `findById`: one row by primary key.
pub(crate) async fn find_by_id<'e, E>(
    executor: E,
    id: &str,
) -> Result<Option<Invoice>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let id_slot = args.push(Arg::Text(id.to_owned()));
    let sql = format!("SELECT {INVOICE_COLUMNS} FROM invoices WHERE id = {id_slot}");
    let row = EventQuery { sql, args }
        .into_query()
        .fetch_optional(executor)
        .await?;

    row.as_ref().map(super::rows::invoice).transpose()
}

/// `upsert`: inserts the row, or updates only `status` and `updated_at` — the capture's
/// merge list, which never carries `amount_paid` or `confirmed_at`.
pub(crate) async fn upsert<'e, E>(executor: E, invoice: &Invoice) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let mut args = Args::default();
    let id_slot = args.push(Arg::Text(invoice.id.clone()));
    let pubkey_slot = args.push(Arg::Bytes(invoice.pubkey.as_bytes().to_vec()));
    let bolt11_slot = args.push(Arg::Text(invoice.bolt11.clone()));
    let requested_slot = args.push(Arg::BigInt(invoice.amount_requested));
    let unit_slot = args.push(Arg::Text(invoice.unit.as_str().to_owned()));
    let status_slot = args.push(Arg::Text(invoice.status.as_str().to_owned()));
    let description_slot = args.push(Arg::Text(invoice.description.clone()));
    let expires_slot = match invoice.expires_at {
        Some(expires_at) => args.push(Arg::NaiveTimestamp(expires_at.naive_utc())),
        None => args.push(Arg::NullNaiveTimestamp),
    };
    let updated_slot = args.push(Arg::Timestamp(now));
    let created_slot = args.push(Arg::Timestamp(invoice.created_at));
    let verify_slot = match &invoice.verify_url {
        Some(url) => args.push(Arg::Text(url.clone())),
        None => args.push(Arg::NullText),
    };

    let sql = format!(
        "INSERT INTO invoices (id, pubkey, bolt11, amount_requested, unit, status, description, \
         expires_at, updated_at, created_at, verify_url) VALUES ({id_slot}, {pubkey_slot}, \
         {bolt11_slot}, {requested_slot}, {unit_slot}, {status_slot}, {description_slot}, \
         {expires_slot}, {updated_slot}, {created_slot}, {verify_slot}) \
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at"
    );

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected())
}

/// `updateStatus`: updates one row and returns it.
pub(crate) async fn update_status<'e, E>(
    executor: E,
    id: &str,
    status: InvoiceStatus,
) -> Result<Option<Invoice>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let id_slot = args.push(Arg::Text(id.to_owned()));
    let status_slot = args.push(Arg::Text(status.as_str().to_owned()));
    let updated_slot = args.push(Arg::Timestamp(Utc::now()));
    let sql = format!(
        "UPDATE invoices SET status = {status_slot}, updated_at = {updated_slot} \
         WHERE id = {id_slot} RETURNING {INVOICE_COLUMNS}"
    );
    let row = EventQuery { sql, args }
        .into_query()
        .fetch_optional(executor)
        .await?;

    row.as_ref().map(super::rows::invoice).transpose()
}

/// `confirmInvoice`: the schema function, which asserts a serializable transaction and
/// scales the credit by the invoice's unit.
pub(crate) async fn confirm_invoice<'e, E>(
    executor: E,
    invoice_id: &str,
    amount_received: i64,
    confirmed_at: DateTime<Utc>,
) -> Result<(), StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let id_slot = args.push(Arg::Text(invoice_id.to_owned()));
    let amount_slot = args.push(Arg::BigInt(amount_received));
    let confirmed_slot = args.push(Arg::NaiveTimestamp(confirmed_at.naive_utc()));
    let sql = format!("SELECT confirm_invoice({id_slot}, {amount_slot}, {confirmed_slot})");

    EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?;
    Ok(())
}

/// `findPendingInvoices`: pending rows, oldest first, paged.
pub(crate) async fn find_pending_invoices<'e, E>(
    executor: E,
    offset: u64,
    limit: u64,
) -> Result<Vec<Invoice>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let status_slot = args.push(Arg::Text(InvoiceStatus::Pending.as_str().to_owned()));
    let offset_slot = args.push(Arg::BigInt(offset as i64));
    let limit_slot = args.push(Arg::BigInt(limit as i64));
    let sql = format!(
        "SELECT {INVOICE_COLUMNS} FROM invoices WHERE status = {status_slot} \
         ORDER BY created_at ASC OFFSET {offset_slot} LIMIT {limit_slot}"
    );
    let rows = EventQuery { sql, args }
        .into_query()
        .fetch_all(executor)
        .await?;

    rows.iter().map(super::rows::invoice).collect()
}
