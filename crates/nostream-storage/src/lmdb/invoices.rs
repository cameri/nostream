//! `InvoiceRepository` against LMDB. Mirrors `src/repositories/invoice-repository.ts`.
//!
//! Two databases: `invoices` by id, and `invoices_pending` (`created_at ‖ id`) holding only
//! the pending rows, which is the partial index `find_pending_invoices` pages through.

use chrono::{DateTime, Utc};
use heed::{RoTxn, RwTxn};

use super::Databases;
use super::encoding;
use super::rows;
use super::users;
use crate::error::StorageError;
use crate::repositories::{Invoice, InvoiceStatus};

/// `findById`: one row by primary key.
pub(crate) fn find_by_id(
    txn: &RoTxn<'_>,
    databases: &Databases,
    id: &str,
) -> Result<Option<Invoice>, StorageError> {
    let Some(value) = databases.invoices.get(txn, id.as_bytes())? else {
        return Ok(None);
    };
    rows::decode("invoices", value).map(Some)
}

/// `created_at ‖ id`, the key of the pending index.
fn pending_key(created_at: DateTime<Utc>, id: &str) -> Vec<u8> {
    let mut key = encoding::i64_key(created_at.timestamp_micros()).to_vec();
    key.extend_from_slice(id.as_bytes());
    key
}

/// Writes a row and moves its pending entry, when the status or the row changed.
fn write(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    invoice: &Invoice,
    previous: Option<&Invoice>,
) -> Result<(), StorageError> {
    let value = rows::encode("invoices", invoice)?;
    databases.invoices.put(txn, invoice.id.as_bytes(), &value)?;
    if let Some(previous) = previous
        && previous.status == InvoiceStatus::Pending
    {
        databases
            .invoices_pending
            .delete(txn, &pending_key(previous.created_at, &previous.id))?;
    }
    if invoice.status == InvoiceStatus::Pending {
        databases
            .invoices_pending
            .put(txn, &pending_key(invoice.created_at, &invoice.id), &[])?;
    }
    Ok(())
}

/// `upsert`: inserts the row, or updates only `status` and `updated_at` — the capture's
/// merge list, which never carries `amount_paid` or `confirmed_at`.
pub(crate) fn upsert(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    invoice: &Invoice,
    now: DateTime<Utc>,
) -> Result<u64, StorageError> {
    match find_by_id(txn, databases, &invoice.id)? {
        Some(mut stored) => {
            let previous = stored.clone();
            stored.status = invoice.status;
            stored.updated_at = encoding::micros(now);
            write(txn, databases, &stored, Some(&previous))?;
        }
        None => {
            let mut stored = invoice.clone();
            // The insert's column list omits both, so the database fills them with NULL.
            stored.amount_paid = None;
            stored.confirmed_at = None;
            stored.updated_at = encoding::micros(now);
            write(txn, databases, &stored, None)?;
        }
    }
    Ok(1)
}

/// `updateStatus`: updates one row and returns it.
pub(crate) fn update_status(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    id: &str,
    status: InvoiceStatus,
    now: DateTime<Utc>,
) -> Result<Option<Invoice>, StorageError> {
    let Some(mut stored) = find_by_id(txn, databases, id)? else {
        return Ok(None);
    };
    let previous = stored.clone();
    stored.status = status;
    stored.updated_at = encoding::micros(now);
    write(txn, databases, &stored, Some(&previous))?;
    Ok(Some(stored))
}

/// The balance credit one unit is worth (`scale_balance_addition_with_unit`).
fn unit_scale(unit: crate::repositories::InvoiceUnit) -> i64 {
    use crate::repositories::InvoiceUnit;
    match unit {
        InvoiceUnit::Msats => 1,
        InvoiceUnit::Sats => 1_000,
        InvoiceUnit::Btc => 100_000_000 * 1_000,
    }
}

/// `confirmInvoice`: the schema function's body, with `int8` overflow answered as
/// [`StorageError::ValueOutOfRange`].
pub(crate) fn confirm_invoice(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    invoice_id: &str,
    amount_received: i64,
    confirmed_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<(), StorageError> {
    let Some(stored) = find_by_id(txn, databases, invoice_id)? else {
        // The capture's `SELECT … INTO` leaves `payee` NULL and both updates match nothing.
        return Ok(());
    };
    if stored.confirmed_at.is_some() {
        return Ok(());
    }

    let credit = amount_received
        .checked_mul(unit_scale(stored.unit))
        .ok_or_else(|| StorageError::ValueOutOfRange {
            column: "users.balance",
            value: amount_received.to_string(),
        })?;
    let payee = users::load(txn, databases, &stored.pubkey)?;
    let balance = match &payee {
        Some(payee) => Some(payee.balance.checked_add(credit).ok_or_else(|| {
            StorageError::ValueOutOfRange {
                column: "users.balance",
                value: payee.balance.to_string(),
            }
        })?),
        None => None,
    };

    let mut confirmed = stored.clone();
    confirmed.confirmed_at = Some(encoding::micros(confirmed_at));
    confirmed.amount_paid = Some(amount_received);
    confirmed.updated_at = encoding::micros(now);
    write(txn, databases, &confirmed, Some(&stored))?;

    if let (Some(mut payee), Some(balance)) = (payee, balance) {
        payee.balance = balance;
        users::store(txn, databases, &payee)?;
    }
    Ok(())
}

/// `findPendingInvoices`: the pending rows, oldest first, paged.
pub(crate) fn find_pending_invoices(
    txn: &RoTxn<'_>,
    databases: &Databases,
    offset: u64,
    limit: u64,
) -> Result<Vec<Invoice>, StorageError> {
    let mut invoices = Vec::new();
    let mut skipped = 0;
    for entry in databases.invoices_pending.iter(txn)? {
        let (key, _) = entry?;
        if skipped < offset {
            skipped += 1;
            continue;
        }
        if invoices.len() as u64 >= limit {
            break;
        }
        let id = key.get(8..).ok_or_else(|| {
            encoding::invalid("invoices_pending", format!("a key of {} bytes", key.len()))
        })?;
        let id = std::str::from_utf8(id).map_err(|_| StorageError::InvalidRow {
            table: "invoices_pending",
            column: "id",
            value: "not utf-8".to_owned(),
        })?;
        if let Some(value) = databases.invoices.get(txn, id.as_bytes())? {
            invoices.push(rows::decode("invoices", value)?);
        }
    }
    Ok(invoices)
}
