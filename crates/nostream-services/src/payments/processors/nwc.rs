//! `nwc-payments-processor.ts` (NIP-47).
//!
//! The protocol lives behind [`Nip47Transport`] so the processor's mapping, timeout and
//! status behaviour are testable without a wallet or a relay; [`NwcRelayTransport`] is the
//! real transport.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use nostream_config::settings::{PaymentsProcessors, Processor};
use nostream_storage::repositories::{Invoice, InvoiceStatus, InvoiceUnit};

use crate::error::ServicesError;
use crate::payments::{
    Env, InvoiceUpdate, PaymentProcessor, ProcessorFuture, ProcessorInvoice, from_unix_seconds, now,
};

/// The largest amount NIP-47's JSON number can carry exactly
/// (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// One NIP-47 request.
#[derive(Debug, Clone, PartialEq)]
pub struct Nip47Request {
    pub method: String,
    pub params: serde_json::Value,
}

/// One NIP-47 reply's `result` document.
#[derive(Debug, Clone, PartialEq)]
pub struct Nip47Response {
    pub result: serde_json::Value,
}

/// The wallet-protocol seam (`@getalby/sdk`'s client).
pub trait Nip47Transport: Send + Sync {
    fn request<'a>(
        &'a self,
        request: &'a Nip47Request,
    ) -> Pin<Box<dyn Future<Output = Result<Nip47Response, ServicesError>> + Send + 'a>>;
}

/// A transaction document from a NIP-47 reply.
fn transaction(response: &Nip47Response) -> &serde_json::Value {
    &response.result
}

/// `mapNwcStateToInvoiceStatus` (`src/payments-processors/nwc-payments-processor.ts:23-35`).
fn map_state(state: Option<&str>) -> InvoiceStatus {
    match state {
        Some("settled") => InvoiceStatus::Completed,
        Some("expired" | "failed") => InvoiceStatus::Expired,
        _ => InvoiceStatus::Pending,
    }
}

/// `timestampToDate`: unix seconds, `<= 0` or non-finite → `None`
/// (`src/payments-processors/nwc-payments-processor.ts:37-43`).
fn timestamp_to_date(value: Option<&serde_json::Value>) -> Option<chrono::DateTime<chrono::Utc>> {
    let number = value?.as_f64()?;

    if !number.is_finite() || number <= 0.0 {
        return None;
    }

    from_unix_seconds(Some(number.trunc() as i64))
}

/// The NWC processor (`src/payments-processors/nwc-payments-processor.ts`).
pub struct NwcProcessor {
    transport: Arc<dyn Nip47Transport>,
    reply_timeout: Duration,
    invoice_expiry_seconds: u64,
}

impl NwcProcessor {
    pub(crate) fn create(
        configured: Option<&PaymentsProcessors>,
        _http: Arc<dyn crate::http::HttpClient>,
        env: &Env<'_>,
    ) -> Result<Box<dyn PaymentProcessor>, ServicesError> {
        let nwc_url = env("NWC_URL")
            .ok_or_else(|| ServicesError::Configuration("NWC_URL must be set.".to_owned()))?;

        if !nwc_url.starts_with("nostr+walletconnect://")
            && !nwc_url.starts_with("nostrwalletconnect://")
        {
            return Err(ServicesError::Configuration(
                "NWC_URL must be a valid nostr+walletconnect:// or nostrwalletconnect:// URI."
                    .to_owned(),
            ));
        }

        if url::Url::parse(&nwc_url).is_err() {
            return Err(ServicesError::Configuration(
                "NWC_URL is not parseable as a URL.".to_owned(),
            ));
        }

        let nwc = configured.and_then(|configured| configured.nwc.as_ref());
        let reply_timeout_ms = nwc.map(|nwc| nwc.reply_timeout_ms).unwrap_or(0);

        if reply_timeout_ms == 0 {
            return Err(ServicesError::Configuration(
                "Setting paymentsProcessors.nwc.replyTimeoutMs must be a positive number."
                    .to_owned(),
            ));
        }

        let invoice_expiry_seconds = nwc.map(|nwc| nwc.invoice_expiry_seconds).unwrap_or(0);

        if invoice_expiry_seconds == 0 {
            return Err(ServicesError::Configuration(
                "Setting paymentsProcessors.nwc.invoiceExpirySeconds must be a positive integer."
                    .to_owned(),
            ));
        }

        let transport = super::nwc_relay::NwcRelayTransport::new(&nwc_url)?;

        Ok(Box::new(Self {
            transport: Arc::new(transport),
            reply_timeout: Duration::from_millis(reply_timeout_ms),
            invoice_expiry_seconds,
        }))
    }

    /// The processor over an injected transport, which is how its behaviour is tested.
    pub fn with_transport(
        transport: Arc<dyn Nip47Transport>,
        reply_timeout: Duration,
        invoice_expiry_seconds: u64,
    ) -> Self {
        Self {
            transport,
            reply_timeout,
            invoice_expiry_seconds,
        }
    }

    fn with_reply_timeout<'a>(
        &'a self,
        request: &'a Nip47Request,
    ) -> Pin<Box<dyn Future<Output = Result<Nip47Response, ServicesError>> + Send + 'a>> {
        let reply_timeout = self.reply_timeout;

        Box::pin(async move {
            match tokio::time::timeout(reply_timeout, self.transport.request(request)).await {
                Ok(response) => response,
                Err(_) => Err(ServicesError::Payment(format!(
                    "reply timeout after {}ms",
                    reply_timeout.as_millis()
                ))),
            }
        })
    }
}

impl PaymentProcessor for NwcProcessor {
    fn processor(&self) -> Option<Processor> {
        Some(Processor::Nwc)
    }

    fn create_invoice<'a>(
        &'a self,
        amount_msats: i64,
        description: &'a str,
        request_id: &'a str,
    ) -> ProcessorFuture<'a, ProcessorInvoice> {
        Box::pin(async move {
            if amount_msats < 0 {
                return Err(ServicesError::Payment(
                    "CreateInvoiceRequest.amount must be a non-negative bigint.".to_owned(),
                ));
            }

            if amount_msats > MAX_SAFE_INTEGER {
                return Err(ServicesError::Payment(
                    "CreateInvoiceRequest.amount exceeds Number.MAX_SAFE_INTEGER.".to_owned(),
                ));
            }

            let request = Nip47Request {
                method: "make_invoice".to_owned(),
                params: serde_json::json!({
                    "amount": amount_msats,
                    "description": description,
                    "expiry": self.invoice_expiry_seconds,
                }),
            };
            let response = self.with_reply_timeout(&request).await?;
            let transaction = transaction(&response);
            let status = map_state(transaction.get("state").and_then(serde_json::Value::as_str));
            let amount_requested = transaction
                .get("amount")
                .and_then(serde_json::Value::as_f64)
                .filter(|amount| amount.is_finite())
                .map(|amount| amount.trunc() as i64)
                .unwrap_or(amount_msats);
            let created_at = timestamp_to_date(transaction.get("created_at")).unwrap_or_else(now);

            Ok(ProcessorInvoice {
                id: transaction
                    .get("payment_hash")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                pubkey: Some(request_id.to_owned()),
                bolt11: transaction
                    .get("invoice")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                amount_requested,
                description: transaction
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(description)
                    .to_owned(),
                unit: InvoiceUnit::Msats,
                status,
                expires_at: timestamp_to_date(transaction.get("expires_at")),
                confirmed_at: (status == InvoiceStatus::Completed)
                    .then(|| timestamp_to_date(transaction.get("settled_at")).unwrap_or_else(now)),
                created_at: Some(created_at),
                verify_url: None,
            })
        })
    }

    fn get_invoice<'a>(&'a self, invoice: &'a Invoice) -> ProcessorFuture<'a, InvoiceUpdate> {
        Box::pin(async move {
            let request = Nip47Request {
                method: "lookup_invoice".to_owned(),
                params: serde_json::json!({ "payment_hash": invoice.id }),
            };
            let response = self.with_reply_timeout(&request).await?;
            let transaction = transaction(&response);
            let status = map_state(transaction.get("state").and_then(serde_json::Value::as_str));
            let amount_requested = transaction
                .get("amount")
                .and_then(serde_json::Value::as_f64)
                .filter(|amount| amount.is_finite())
                .map(|amount| amount.trunc() as i64)
                .unwrap_or(invoice.amount_requested);

            Ok(InvoiceUpdate {
                id: Some(
                    transaction
                        .get("payment_hash")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(&invoice.id)
                        .to_owned(),
                ),
                pubkey: Some(invoice.pubkey.to_string()),
                bolt11: Some(
                    transaction
                        .get("invoice")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(&invoice.bolt11)
                        .to_owned(),
                ),
                amount_requested: Some(amount_requested),
                amount_paid: (status == InvoiceStatus::Completed).then_some(amount_requested),
                unit: Some(InvoiceUnit::Msats),
                status: Some(status),
                description: Some(
                    transaction
                        .get("description")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(&invoice.description)
                        .to_owned(),
                ),
                confirmed_at: (status == InvoiceStatus::Completed)
                    .then(|| timestamp_to_date(transaction.get("settled_at")).unwrap_or_else(now)),
                expires_at: timestamp_to_date(transaction.get("expires_at")),
                created_at: timestamp_to_date(transaction.get("created_at")),
                verify_url: None,
            })
        })
    }
}
