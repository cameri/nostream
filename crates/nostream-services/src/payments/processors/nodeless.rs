//! `nodeless-payments-processor.ts` and `fromNodelessInvoice`
//! (`src/utils/transform.ts:208-238`).

use std::sync::Arc;
use std::time::Duration;

use chrono::TimeDelta;
use nostream_config::settings::{PaymentsProcessors, Processor};
use nostream_storage::repositories::{Invoice, InvoiceStatus};

use crate::error::ServicesError;
use crate::http::{HttpClient, join_url, parse_json, post_json};
use crate::payments::{
    Env, InvoiceUpdate, PaymentProcessor, ProcessorFuture, ProcessorInvoice, from_iso, now,
    parse_unit, text_field,
};

/// The timeout a processor request takes when it names none (axios' own default).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The expiry a Nodeless invoice gets when the provider reports none
/// (`src/utils/transform.ts:225-229`), fifteen minutes.
const FALLBACK_EXPIRY: TimeDelta = TimeDelta::minutes(15);

/// The Nodeless processor (`src/payments-processors/nodeless-payments-processor.ts`).
pub struct NodelessProcessor {
    http: Arc<dyn HttpClient>,
    base_url: String,
    store_id: String,
}

impl NodelessProcessor {
    pub(crate) fn create(
        configured: Option<&PaymentsProcessors>,
        http: Arc<dyn HttpClient>,
        env: &Env<'_>,
    ) -> Result<Box<dyn PaymentProcessor>, ServicesError> {
        if env("NODELESS_API_KEY").is_none() {
            return Err(ServicesError::Configuration(
                "NODELESS_API_KEY must be set.".to_owned(),
            ));
        }

        let nodeless = configured
            .and_then(|configured| configured.nodeless.as_ref())
            .ok_or_else(|| {
                ServicesError::Configuration(
                    "Setting paymentsProcessor.nodeless.storeId is not configured.".to_owned(),
                )
            })?;

        Ok(Box::new(Self {
            http,
            base_url: nodeless.base_url.clone(),
            store_id: nodeless.store_id.clone(),
        }))
    }
}

/// `fromNodelessInvoice` (`src/utils/transform.ts:208-238`).
fn from_nodeless_invoice(document: &serde_json::Value) -> Result<ProcessorInvoice, ServicesError> {
    let metadata = document.get("metadata").cloned().unwrap_or_default();
    let status = match text_field(document, "status").as_deref() {
        Some("new" | "pending_confirmation" | "underpaid" | "in_flight") => InvoiceStatus::Pending,
        Some("paid" | "overpaid") => InvoiceStatus::Completed,
        Some("expired") => InvoiceStatus::Expired,
        Some(other) => {
            return Err(ServicesError::Payment(format!(
                "unknown invoice status: {other}"
            )));
        }
        None => InvoiceStatus::Pending,
    };
    let created_at = from_iso(document.get("createdAt"));

    Ok(ProcessorInvoice {
        id: text_field(document, "id").unwrap_or_default(),
        pubkey: text_field(&metadata, "requestId"),
        bolt11: text_field(document, "lightningInvoice").unwrap_or_default(),
        amount_requested: document
            .get("satsAmount")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        description: text_field(&metadata, "description").unwrap_or_default(),
        unit: parse_unit(
            &text_field(&metadata, "unit")
                .or_else(|| text_field(document, "unit"))
                .unwrap_or_else(|| "sats".to_owned()),
        )?,
        status,
        expires_at: from_iso(document.get("expiresAt")).or_else(|| {
            created_at.and_then(|created_at| created_at.checked_add_signed(FALLBACK_EXPIRY))
        }),
        confirmed_at: from_iso(document.get("paidAt")),
        created_at,
        verify_url: None,
    })
}

impl PaymentProcessor for NodelessProcessor {
    fn processor(&self) -> Option<Processor> {
        Some(Processor::Nodeless)
    }

    fn create_invoice<'a>(
        &'a self,
        amount_msats: i64,
        description: &'a str,
        request_id: &'a str,
    ) -> ProcessorFuture<'a, ProcessorInvoice> {
        Box::pin(async move {
            let url = join_url(
                &self.base_url,
                &format!("/api/v1/store/{}/invoice", self.store_id),
            );
            let body = serde_json::json!({
                "amount": amount_msats / 1000,
                "currency": "SATS",
                "metadata": {
                    "description": description,
                    "requestId": request_id,
                    "unit": "sats",
                    "createdAt": now().to_rfc3339(),
                },
            });
            let response = post_json(self.http.as_ref(), &url, &body, REQUEST_TIMEOUT).await?;
            let document = parse_json(&response)?;

            from_nodeless_invoice(
                document
                    .get("data")
                    .ok_or_else(|| ServicesError::Payment("response has no data".to_owned()))?,
            )
        })
    }

    fn get_invoice<'a>(&'a self, invoice: &'a Invoice) -> ProcessorFuture<'a, InvoiceUpdate> {
        Box::pin(async move {
            let url = join_url(
                &self.base_url,
                &format!("/api/v1/store/{}/invoice/{}", self.store_id, invoice.id),
            );
            let response = self.http.get(&url, REQUEST_TIMEOUT).await?;
            let document = parse_json(&response)?;
            let decoded = from_nodeless_invoice(
                document
                    .get("data")
                    .ok_or_else(|| ServicesError::Payment("response has no data".to_owned()))?,
            )?;

            Ok(InvoiceUpdate {
                id: Some(decoded.id),
                pubkey: decoded.pubkey,
                bolt11: Some(decoded.bolt11),
                amount_requested: Some(decoded.amount_requested),
                amount_paid: (decoded.status == InvoiceStatus::Completed)
                    .then_some(decoded.amount_requested),
                unit: Some(decoded.unit),
                status: Some(decoded.status),
                description: Some(decoded.description),
                confirmed_at: decoded.confirmed_at,
                expires_at: decoded.expires_at,
                created_at: decoded.created_at,
                verify_url: None,
            })
        })
    }
}
