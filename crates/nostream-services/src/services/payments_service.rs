//! `payments-service.ts`: invoice creation, confirmation, the pending-invoice walk and the
//! two relay-signed invoice notifications.

use std::sync::Arc;

use chrono::{DateTime, Datelike, Days, Local, NaiveDate, TimeDelta, TimeZone, Utc};
use tokio::sync::broadcast;

use nostream_config::Settings;
use nostream_config::settings::FeeSchedule;
use nostream_core::Pubkey;
use nostream_core::clock::Clock;
use nostream_core::crypto::sign_event;
use nostream_core::event::{Event, EventId, Signature};
use nostream_relay::relay_key::RelayKeySource;
use nostream_storage::repositories::{
    EventRecord, FieldUpdate, Invoice, InvoiceStatus, InvoiceUnit, UserPatch,
};

use crate::error::ServicesError;
use crate::invoice::{is_expired_invoice, resolve_invoice_expiry};
use crate::payments::{INVOICE_UPDATE_KIND, InvoiceUpdate, PaymentProcessor};
use crate::unavailable::ServiceStores;

/// Invoices per maintenance pass (`PENDING_INVOICE_PAGE_SIZE`,
/// `src/services/payments-service.ts:27`).
pub const PENDING_INVOICE_PAGE_SIZE: u64 = 10;

/// The two relay-authored notification event types.
pub const ADMISSION_INVOICE_CREATED: &str = "admission.invoice.created";
pub const ADMISSION_INVOICE_PAID: &str = "admission.invoice.paid";
pub const ADMISSION_INVOICE_FAILED: &str = "admission.invoice.failed";

/// `PaymentsService`.
pub struct PaymentsService {
    settings: Arc<Settings>,
    clock: Arc<dyn Clock>,
    keys: Arc<RelayKeySource>,
    stores: Arc<ServiceStores>,
    hub: broadcast::Sender<Arc<Event>>,
    processor: Arc<dyn PaymentProcessor>,
}

impl PaymentsService {
    /// Builds the service over one processor.
    pub fn new(
        settings: Arc<Settings>,
        clock: Arc<dyn Clock>,
        keys: Arc<RelayKeySource>,
        stores: Arc<ServiceStores>,
        hub: broadcast::Sender<Arc<Event>>,
        processor: Arc<dyn PaymentProcessor>,
    ) -> Self {
        Self {
            settings,
            clock,
            keys,
            stores,
            hub,
            processor,
        }
    }

    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(i64::try_from(self.clock.now_ms()).unwrap_or(i64::MAX))
            .unwrap_or(DateTime::UNIX_EPOCH)
    }

    /// One page of pending invoices (`getPendingInvoices`).
    pub async fn get_pending_invoices(&self, offset: u64) -> Result<Vec<Invoice>, ServicesError> {
        Ok(self
            .stores
            .invoices
            .find_pending_invoices(offset, PENDING_INVOICE_PAGE_SIZE)
            .await?)
    }

    /// `createInvoice`: the user row, the processor, the expiry, the invoice, the outbox row.
    pub async fn create_invoice(
        &self,
        pubkey: &Pubkey,
        amount_msats: i64,
        description: &str,
    ) -> Result<Invoice, ServicesError> {
        // The row is created when absent; an existing admission or vanish flag is left alone.
        // Writing `false` here would clear an admitted user's admission on every new invoice.
        self.stores
            .users
            .upsert(&UserPatch {
                pubkey: *pubkey,
                is_admitted: FieldUpdate::Absent,
                is_vanished: FieldUpdate::Absent,
                tos_accepted_at: FieldUpdate::Absent,
            })
            .await?;

        let created = self
            .processor
            .create_invoice(amount_msats, description, &pubkey.to_string())
            .await?;

        let now = self.now();
        let expires_at = resolve_invoice_expiry(
            created.expires_at,
            Some(now),
            self.settings
                .payments
                .as_ref()
                .and_then(|payments| payments.invoice_expiry_seconds),
            now,
        );

        let invoice = Invoice {
            id: created.id,
            pubkey: *pubkey,
            bolt11: created.bolt11,
            amount_requested: created.amount_requested,
            amount_paid: None,
            unit: created.unit,
            status: created.status,
            description: created.description,
            confirmed_at: None,
            expires_at: Some(expires_at),
            updated_at: now,
            created_at: now,
            verify_url: created.verify_url,
        };

        self.stores.invoices.upsert(&invoice).await?;

        self.stores
            .notification_outbox
            .enqueue(
                ADMISSION_INVOICE_CREATED,
                &serde_json::json!({
                    "invoiceId": invoice.id,
                    "pubkey": invoice.pubkey,
                    "amountRequested": invoice.amount_requested.to_string(),
                    "unit": invoice.unit.as_str(),
                }),
            )
            .await?;

        Ok(invoice)
    }

    /// `updateInvoiceStatus`.
    pub async fn update_invoice_status(
        &self,
        id: &str,
        status: InvoiceStatus,
    ) -> Result<Option<Invoice>, ServicesError> {
        Ok(self.stores.invoices.update_status(id, status).await?)
    }

    /// `confirmInvoice`: the three guards, the confirmation, admission and the outbox row.
    pub async fn confirm_invoice(&self, invoice: &Invoice) -> Result<(), ServicesError> {
        let Some(confirmed_at) = invoice.confirmed_at else {
            return Err(ServicesError::Payment(
                "Invoice confirmation date is not set".to_owned(),
            ));
        };

        if invoice.status != InvoiceStatus::Completed {
            return Err(ServicesError::Payment(format!(
                "Invoice is not complete: {}",
                invoice.status
            )));
        }

        let Some(amount_paid) = invoice.amount_paid else {
            return Err(ServicesError::Payment(
                "Invoice paid amount is not set: undefined".to_owned(),
            ));
        };

        self.stores
            .invoices
            .confirm_invoice(&invoice.id, amount_paid, confirmed_at)
            .await?;

        let amount_paid_msats = to_msats(amount_paid, invoice.unit);
        let admission_fee = self.admission_fee(&invoice.pubkey);

        if admission_fee > 0 && amount_paid_msats >= admission_fee {
            self.stores
                .users
                .admit_user(&invoice.pubkey, self.now())
                .await?;
        }

        self.stores
            .notification_outbox
            .enqueue(
                ADMISSION_INVOICE_PAID,
                &serde_json::json!({
                    "invoiceId": invoice.id,
                    "pubkey": invoice.pubkey,
                    "amountPaid": invoice.amount_paid.unwrap_or_default().to_string(),
                    "unit": invoice.unit.as_str(),
                    "confirmedAt": confirmed_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                }),
            )
            .await?;

        Ok(())
    }

    /// The admission fee the payer owes (`src/services/payments-service.ts:205-210`).
    fn admission_fee(&self, pubkey: &Pubkey) -> i64 {
        let payer = pubkey.to_string();

        self.settings
            .payments
            .as_ref()
            .map(|payments| payments.fee_schedules.admission.as_slice())
            .unwrap_or_default()
            .iter()
            .filter(|schedule| is_applicable_fee(schedule, &payer))
            .map(|schedule| schedule.amount)
            .fold(0i64, i64::saturating_add)
    }

    /// `sendInvoiceUpdateNotification`: a relay-signed kind-402 event.
    pub async fn send_invoice_update_notification(
        &self,
        invoice: &Invoice,
    ) -> Result<(), ServicesError> {
        let Some(amount_paid) = invoice.amount_paid else {
            return Err(ServicesError::Payment(format!(
                "Unable to notify user {} for invoice {}",
                invoice.pubkey, invoice.id
            )));
        };

        let (amount, unit) = display_amount(amount_paid, invoice.unit);
        let expiration = next_month_midnight(self.now());
        let content = format!("Invoice paid: {amount} {unit}");

        self.publish_invoice_notification(invoice, &content, expiration)
            .await;

        Ok(())
    }

    /// `sendRenewalNotification`.
    pub async fn send_renewal_notification(&self, invoice: &Invoice) -> Result<(), ServicesError> {
        let (amount, unit) = display_amount(invoice.amount_requested, invoice.unit);
        let expiration = invoice
            .expires_at
            .unwrap_or_else(|| self.now() + TimeDelta::hours(24));
        let content = format!("Subscription renewal due: {amount} {unit}");

        self.publish_invoice_notification(invoice, &content, expiration)
            .await;

        Ok(())
    }

    /// Persists and broadcasts one invoice notification. A signing or persistence failure is
    /// logged and never propagated (`src/services/payments-service.ts:306-331`).
    async fn publish_invoice_notification(
        &self,
        invoice: &Invoice,
        content: &str,
        expiration: DateTime<Utc>,
    ) {
        let outcome = async {
            let keys = self
                .keys
                .resolve(&self.settings.info.relay_url)
                .map_err(|error| ServicesError::Payment(error.to_string()))?;

            let mut event = Event {
                id: EventId::from_byte_array([0; 32]),
                pubkey: keys.public_key,
                created_at: self.clock.now_secs(),
                kind: INVOICE_UPDATE_KIND,
                content: content.to_owned(),
                tags: vec![
                    vec!["p".to_owned(), invoice.pubkey.to_string()],
                    vec!["invoice".to_owned(), invoice.bolt11.clone()],
                    vec!["expiration".to_owned(), expiration.timestamp().to_string()],
                ],
                sig: Signature::from_byte_array([0; 64]),
            };
            sign_event(&keys.secret_key, &mut event)
                .map_err(|error| ServicesError::Payment(error.to_string()))?;

            self.stores
                .events
                .create(&EventRecord::from_event(&event))
                .await?;
            let _ = self.hub.send(Arc::new(event));

            Ok::<(), ServicesError>(())
        }
        .await;

        if let Err(error) = outcome {
            tracing::error!(invoice_id = invoice.id, error = %error, "Unable to send notification");
        }
    }

    /// The maintenance pass's invoice walk: one page, the processor lookup, the 404 rule and
    /// the confirm-on-change step (`src/app/maintenance-worker.ts:190-258`).
    pub async fn walk_pending_invoices(&self, offset: &mut u64) -> Result<(), ServicesError> {
        let invoices = self.get_pending_invoices(*offset).await?;

        *offset = if (invoices.len() as u64) < PENDING_INVOICE_PAGE_SIZE {
            0
        } else {
            offset.saturating_add(PENDING_INVOICE_PAGE_SIZE)
        };

        for invoice in invoices {
            match self.processor.get_invoice(&invoice).await {
                Ok(update) => {
                    let (Some(id), Some(status)) = (update.id.clone(), update.status) else {
                        continue;
                    };

                    self.update_invoice_status(&id, status).await?;

                    if invoice.status != status
                        && status == InvoiceStatus::Completed
                        && update.confirmed_at.is_some()
                    {
                        let updated = merge_update(&invoice, &update);

                        let (confirmed, notified) = tokio::join!(
                            self.confirm_invoice(&updated),
                            self.send_invoice_update_notification(&updated)
                        );

                        for outcome in [confirmed, notified] {
                            if let Err(error) = outcome {
                                tracing::error!(
                                    invoice_id = invoice.id,
                                    error = %error,
                                    "Unable to confirm an invoice from the walk"
                                );
                            }
                        }
                    }
                }
                Err(error) if error.http_status() == Some(404) => {
                    if is_expired_invoice(invoice.expires_at, self.now()) {
                        tracing::info!(
                            invoice_id = invoice.id,
                            "marking expired invoice after the processor returned 404"
                        );
                        self.update_invoice_status(&invoice.id, InvoiceStatus::Expired)
                            .await?;

                        if let Err(error) = self
                            .stores
                            .notification_outbox
                            .enqueue(
                                ADMISSION_INVOICE_FAILED,
                                &serde_json::json!({
                                    "invoiceId": invoice.id,
                                    "pubkey": invoice.pubkey,
                                    "reason": "expired",
                                }),
                            )
                            .await
                        {
                            tracing::error!(
                                error = %error,
                                "Unable to enqueue admission.invoice.failed notification"
                            );
                        }
                    }
                }
                Err(error) => {
                    tracing::error!(
                        invoice_id = invoice.id,
                        error = %error,
                        "Unable to update invoice from payment processor"
                    );
                }
            }
        }

        Ok(())
    }
}

fn is_applicable_fee(schedule: &FeeSchedule, payer: &str) -> bool {
    schedule.enabled
        && !schedule
            .whitelists
            .as_ref()
            .and_then(|whitelists| whitelists.pubkeys.as_ref())
            .is_some_and(|pubkeys| pubkeys.iter().any(|pubkey| pubkey.0 == payer))
}

/// sats × 1000, btc × 1000 × 100 000 000 (`src/services/payments-service.ts:196-203`).
fn to_msats(amount: i64, unit: InvoiceUnit) -> i64 {
    match unit {
        InvoiceUnit::Msats => amount,
        InvoiceUnit::Sats => amount.saturating_mul(1_000),
        InvoiceUnit::Btc => amount.saturating_mul(1_000).saturating_mul(100_000_000),
    }
}

/// The amount and unit the notification text shows: msats are shown in sats.
fn display_amount(amount: i64, unit: InvoiceUnit) -> (i64, &'static str) {
    match unit {
        InvoiceUnit::Msats => (amount / 1_000, InvoiceUnit::Sats.as_str()),
        other => (amount, other.as_str()),
    }
}

/// `new Date(y, m + 1, d)`: local midnight of the same day in the next month (V14).
///
/// The constructor rolls an overflow into the month after it (31 January becomes 2 March in a
/// leap year), so the day offset is applied to the first of the target month instead of asking
/// for a date that does not exist. The old fallback returned `now`, which published a
/// notification that had already expired.
fn next_month_midnight(now: DateTime<Utc>) -> DateTime<Utc> {
    let local = now.with_timezone(&Local);

    next_month_date(local.date_naive())
        .and_then(|date| local_midnight(date, &Local))
        .map(|midnight| midnight.with_timezone(&Utc))
        .unwrap_or(now)
}

/// The first instant of `date` in `zone`.
///
/// Midnight itself does not exist in a zone whose spring-forward lands on 00:00, and falling
/// back to `now` there would publish a notification that has already expired. The first hour
/// that does exist is the day's beginning for every purpose this value has.
fn local_midnight<Tz: TimeZone>(date: NaiveDate, zone: &Tz) -> Option<DateTime<Tz>> {
    (0..4).find_map(|hour| {
        let naive = date.and_hms_opt(hour, 0, 0)?;

        zone.from_local_datetime(&naive)
            .earliest()
            .or_else(|| zone.from_local_datetime(&naive).latest())
    })
}

/// The date part of `new Date(y, m + 1, d)`.
fn next_month_date(date: NaiveDate) -> Option<NaiveDate> {
    let (year, month) = if date.month() == 12 {
        (date.year() + 1, 1)
    } else {
        (date.year(), date.month() + 1)
    };

    NaiveDate::from_ymd_opt(year, month, 1)?.checked_add_days(Days::new(u64::from(date.day() - 1)))
}

/// The capture's `mergeDeepLeft(updatedInvoice)` over `mergeDeepLeft({amountPaid})`.
fn merge_update(invoice: &Invoice, update: &InvoiceUpdate) -> Invoice {
    let mut updated = invoice.clone();

    if let Some(id) = &update.id {
        updated.id.clone_from(id);
    }
    if let Some(pubkey) = update
        .pubkey
        .as_deref()
        .and_then(|pubkey| pubkey.parse().ok())
    {
        updated.pubkey = pubkey;
    }
    if let Some(bolt11) = &update.bolt11 {
        updated.bolt11.clone_from(bolt11);
    }
    if let Some(amount_requested) = update.amount_requested {
        updated.amount_requested = amount_requested;
    }
    if let Some(unit) = update.unit {
        updated.unit = unit;
    }
    if let Some(status) = update.status {
        updated.status = status;
    }
    if let Some(description) = &update.description {
        updated.description.clone_from(description);
    }
    if let Some(confirmed_at) = update.confirmed_at {
        updated.confirmed_at = Some(confirmed_at);
    }
    if let Some(expires_at) = update.expires_at {
        updated.expires_at = Some(expires_at);
    }
    if let Some(created_at) = update.created_at {
        updated.created_at = created_at;
    }
    if let Some(verify_url) = &update.verify_url {
        updated.verify_url = Some(verify_url.clone());
    }

    // R26: `mergeDeepLeft({ amountPaid: invoice.amountRequested })` wins over whatever the
    // provider reported (`src/app/maintenance-worker.ts:225-232`).
    updated.amount_paid = Some(invoice.amount_requested);
    updated
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use chrono::{LocalResult, NaiveDate, NaiveDateTime, Offset, TimeZone};

    use super::{local_midnight, next_month_date};

    /// A zone that skips 00:00 on one date, as a spring-forward at midnight does.
    #[derive(Clone, Copy)]
    struct MidnightSkipped(NaiveDate);

    #[derive(Clone, Debug)]
    struct Utc;

    impl Offset for Utc {
        fn fix(&self) -> chrono::FixedOffset {
            chrono::FixedOffset::east_opt(0).expect("UTC")
        }
    }

    impl TimeZone for MidnightSkipped {
        type Offset = Utc;

        fn from_offset(_offset: &Self::Offset) -> Self {
            MidnightSkipped(NaiveDate::from_ymd_opt(1970, 1, 1).expect("a date"))
        }

        fn offset_from_local_date(&self, _local: &NaiveDate) -> LocalResult<Self::Offset> {
            LocalResult::Single(Utc)
        }

        fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<Self::Offset> {
            if local.date() == self.0
                && local.time() < chrono::NaiveTime::from_hms_opt(1, 0, 0).expect("01:00")
            {
                return LocalResult::None;
            }

            LocalResult::Single(Utc)
        }

        fn offset_from_utc_date(&self, _utc: &NaiveDate) -> Self::Offset {
            Utc
        }

        fn offset_from_utc_datetime(&self, _utc: &NaiveDateTime) -> Self::Offset {
            Utc
        }
    }

    fn date(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).expect("a date")
    }

    #[test]
    fn the_next_month_is_the_same_day_when_it_exists() {
        assert_eq!(next_month_date(date(2024, 1, 15)), Some(date(2024, 2, 15)));
        assert_eq!(next_month_date(date(2024, 12, 15)), Some(date(2025, 1, 15)));
    }

    /// A zone that skips midnight still gets the day's first existing instant, not `now`.
    #[test]
    fn a_local_midnight_that_does_not_exist_falls_to_the_first_hour_that_does() {
        let date = date(2024, 3, 31);
        let zone = MidnightSkipped(date);

        let midnight = local_midnight(date, &zone).expect("the day has an instant");

        assert_eq!(
            midnight.naive_local(),
            date.and_hms_opt(1, 0, 0).expect("01:00")
        );
    }

    #[test]
    fn an_ordinary_day_starts_at_midnight() {
        let day = date(2024, 3, 30);
        let midnight = local_midnight(day, &MidnightSkipped(date(2024, 3, 31)))
            .expect("the day has an instant");

        assert_eq!(
            midnight.naive_local(),
            day.and_hms_opt(0, 0, 0).expect("00:00")
        );
    }

    /// `new Date(2024, 1, 31)` is 2 March, not 31 February and not `now`: a notification
    /// carrying `now` as its expiration has already expired.
    #[test]
    fn a_month_end_rolls_into_the_month_after_it() {
        assert_eq!(next_month_date(date(2024, 1, 31)), Some(date(2024, 3, 2)));
        assert_eq!(next_month_date(date(2023, 1, 31)), Some(date(2023, 3, 3)));
        assert_eq!(next_month_date(date(2024, 2, 29)), Some(date(2024, 3, 29)));
        assert_eq!(next_month_date(date(2024, 12, 31)), Some(date(2025, 1, 31)));
        // April has 30 days: `new Date(2023, 3, 31)` is 1 May.
        assert_eq!(next_month_date(date(2023, 3, 31)), Some(date(2023, 5, 1)));
    }
}
