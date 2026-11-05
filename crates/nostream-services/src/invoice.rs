//! Invoice expiry arithmetic. Mirrors `src/utils/invoice.ts`.

use chrono::{DateTime, TimeDelta, Utc};

/// The fallback expiry (`DEFAULT_INVOICE_EXPIRY_SECONDS`, `src/utils/invoice.ts:6`).
pub const DEFAULT_INVOICE_EXPIRY_SECONDS: u64 = 86_400;

/// The cap on the configured fallback (`MAX_INVOICE_EXPIRY_SECONDS`,
/// `src/utils/invoice.ts:9`).
pub const MAX_INVOICE_EXPIRY_SECONDS: u64 = 30 * 86_400;

/// The configured fallback: a positive value, capped, else 86 400
/// (`resolveInvoiceExpirySeconds`, `src/utils/invoice.ts:14-20`).
pub fn resolve_invoice_expiry_seconds(configured: Option<u64>) -> u64 {
    match configured {
        Some(seconds) if seconds > 0 => seconds.min(MAX_INVOICE_EXPIRY_SECONDS),
        _ => DEFAULT_INVOICE_EXPIRY_SECONDS,
    }
}

/// Every invoice needs an expiry: a usable processor date wins, otherwise `created_at`
/// (or `now` when it is absent) plus the configured fallback (`resolveInvoiceExpiry`,
/// `src/utils/invoice.ts:28-40`).
pub fn resolve_invoice_expiry(
    processor_expiry: Option<DateTime<Utc>>,
    created_at: Option<DateTime<Utc>>,
    configured_seconds: Option<u64>,
    now: DateTime<Utc>,
) -> DateTime<Utc> {
    if let Some(expiry) = processor_expiry {
        return expiry;
    }

    let base = created_at.unwrap_or(now);
    let seconds =
        i64::try_from(resolve_invoice_expiry_seconds(configured_seconds)).unwrap_or(i64::MAX);

    base + TimeDelta::try_seconds(seconds).unwrap_or(TimeDelta::MAX)
}

/// Whether an invoice's expiry has passed: `expires_at <= now` (`isExpiredInvoice`,
/// `src/utils/invoice.ts:11-12`); no expiry is never expired.
pub fn is_expired_invoice(expires_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    expires_at.is_some_and(|expires_at| expires_at <= now)
}
