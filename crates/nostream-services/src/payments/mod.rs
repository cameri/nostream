//! The payment-processor seam. Mirrors `src/payments-processors/*-payment(s)-processor.ts`,
//! `src/factories/payments-processor-factory.ts` and `src/@types/settings.ts`'
//! `keyof PaymentsProcessors`.
//!
//! One trait serves all seven processors: the six a setting names plus the null processor
//! the factory answers when payments are disabled. `processor()` returns `None` for the null
//! processor because the settings enum has no variant for it.

use std::pin::Pin;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use nostream_config::settings::{Processor, Settings};
use nostream_core::Kind;
use nostream_storage::repositories::{Invoice, InvoiceStatus, InvoiceUnit};

use crate::error::ServicesError;
use crate::http::HttpClient;

mod processors;

pub use processors::nwc::{Nip47Request, Nip47Response, Nip47Transport, NwcProcessor};
pub use processors::nwc_relay::NwcRelayTransport;

/// One processor call's future.
pub type ProcessorFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ServicesError>> + Send + 'a>>;

/// Kind 402, `EventKinds.INVOICE_UPDATE` (`src/constants/base.ts:39`).
pub const INVOICE_UPDATE_KIND: Kind = Kind(402);

/// One invoice as a processor creates it (`CreateInvoiceResponse`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessorInvoice {
    pub id: String,
    pub pubkey: Option<String>,
    pub bolt11: String,
    pub amount_requested: i64,
    pub description: String,
    pub unit: InvoiceUnit,
    pub status: InvoiceStatus,
    pub expires_at: Option<DateTime<Utc>>,
    pub confirmed_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub verify_url: Option<String>,
}

/// The capture's `Partial<Invoice>`: every field a lookup may report. An absent field leaves
/// the stored value alone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InvoiceUpdate {
    pub id: Option<String>,
    pub pubkey: Option<String>,
    pub bolt11: Option<String>,
    pub amount_requested: Option<i64>,
    pub amount_paid: Option<i64>,
    pub unit: Option<InvoiceUnit>,
    pub status: Option<InvoiceStatus>,
    pub description: Option<String>,
    pub confirmed_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub verify_url: Option<String>,
}

/// What every processor implements, one variant per `keyof PaymentsProcessors` plus the
/// factory's null processor.
pub trait PaymentProcessor: Send + Sync + 'static {
    /// The processor this implementation serves; `None` is the null processor.
    fn processor(&self) -> Option<Processor>;

    /// Creates an invoice for an admission/publication fee (`createInvoice`).
    fn create_invoice<'a>(
        &'a self,
        amount_msats: i64,
        description: &'a str,
        request_id: &'a str,
    ) -> ProcessorFuture<'a, ProcessorInvoice>;

    /// Reads back the invoice's current state (`getInvoice`).
    fn get_invoice<'a>(&'a self, invoice: &'a Invoice) -> ProcessorFuture<'a, InvoiceUpdate>;
}

/// The environment the processor factories read, so a test can supply the keys it needs
/// without mutating the process environment (which Rust 2024 makes `unsafe`).
pub type Env<'a> = dyn Fn(&str) -> Option<String> + Send + Sync + 'a;

/// Resolves the configured processor, reading the process environment for its keys.
pub fn resolve(
    settings: &Settings,
    http: Arc<dyn HttpClient>,
) -> Result<Box<dyn PaymentProcessor>, ServicesError> {
    resolve_with_env(settings, http, &|name| std::env::var(name).ok())
}

/// Resolves the processor the settings name (`createPaymentsProcessor`,
/// `src/factories/payments-processor-factory.ts:14-37`).
///
/// Disabled or absent payments answer the null processor; every construction failure is a
/// [`ServicesError::Configuration`] carrying the capture's verbatim message.
pub fn resolve_with_env(
    settings: &Settings,
    http: Arc<dyn HttpClient>,
    env: &Env<'_>,
) -> Result<Box<dyn PaymentProcessor>, ServicesError> {
    let Some(payments) = settings
        .payments
        .as_ref()
        .filter(|payments| payments.enabled)
    else {
        return Ok(Box::new(processors::null::NullProcessor::new()));
    };

    let configured = settings.payments_processors.as_ref();

    match payments.processor {
        Processor::Lnurl => processors::lnurl::LnurlProcessor::create(configured, http),
        Processor::Zebedee => processors::zebedee::ZebedeeProcessor::create(configured, http, env),
        Processor::Lnbits => processors::lnbits::LnbitsProcessor::create(configured, http, env),
        Processor::Nodeless => {
            processors::nodeless::NodelessProcessor::create(configured, http, env)
        }
        Processor::Opennode => {
            processors::opennode::OpennodeProcessor::create(configured, http, env)
        }
        Processor::Nwc => processors::nwc::NwcProcessor::create(configured, http, env),
    }
}

/// `new Date()` in the capture: the processors stamp `createdAt`/`confirmedAt` with the wall
/// clock, and no acceptance criterion depends on their instant.
pub(crate) fn now() -> DateTime<Utc> {
    chrono::Utc::now()
}

/// The lowercase invoice unit a provider reports.
pub(crate) fn parse_unit(value: &str) -> Result<InvoiceUnit, ServicesError> {
    value
        .parse::<InvoiceUnit>()
        .map_err(|_| ServicesError::Payment(format!("unknown invoice unit: {value}")))
}

/// The lowercase invoice status a provider reports.
pub(crate) fn parse_status(value: &str) -> Result<InvoiceStatus, ServicesError> {
    value
        .parse::<InvoiceStatus>()
        .map_err(|_| ServicesError::Payment(format!("unknown invoice status: {value}")))
}

/// A unix-seconds timestamp, `None` for a non-positive or absent value.
pub(crate) fn from_unix_seconds(seconds: Option<i64>) -> Option<DateTime<Utc>> {
    seconds
        .filter(|seconds| *seconds > 0)
        .and_then(|seconds| DateTime::from_timestamp(seconds, 0))
}

/// An ISO-8601 timestamp, `None` when absent or unparseable.
pub(crate) fn from_iso(value: Option<&serde_json::Value>) -> Option<DateTime<Utc>> {
    let text = value?.as_str()?;

    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|parsed| parsed.with_timezone(&Utc))
}

/// A timestamp that LNbits reports as unix seconds (a number) or as an ISO string.
pub(crate) fn from_seconds_or_iso(value: Option<&serde_json::Value>) -> Option<DateTime<Utc>> {
    let value = value?;

    match value {
        serde_json::Value::Number(number) => from_unix_seconds(number.as_i64()),
        serde_json::Value::String(_) => from_iso(Some(value)),
        _ => None,
    }
}

/// A JSON string field.
pub(crate) fn text_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_owned)
}

/// A JSON integer field, accepting the decimal string a provider may send.
pub(crate) fn integer_field(value: &serde_json::Value, key: &str) -> Option<i64> {
    match value.get(key)? {
        serde_json::Value::Number(number) => number.as_i64(),
        serde_json::Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

/// A server-minted version-4 UUID (`randomUUID()`).
pub(crate) fn uuid_v4(
    random: &dyn nostream_core::random::RandomSource,
) -> Result<String, ServicesError> {
    let mut bytes = random
        .bytes(16)
        .map_err(|error| ServicesError::Payment(error.to_string()))?;

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    Ok(format!(
        "{}-{}-{}-{}-{}",
        hex::encode(&bytes[0..4]),
        hex::encode(&bytes[4..6]),
        hex::encode(&bytes[6..8]),
        hex::encode(&bytes[8..10]),
        hex::encode(&bytes[10..16])
    ))
}

/// `hmacSha256(key, data)` (`src/utils/secret.ts:11-13`).
pub(crate) fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, ServicesError> {
    use hmac::{Hmac, KeyInit, Mac};
    use sha2::Sha256;

    let mut mac = Hmac::<Sha256>::new_from_slice(key)
        .map_err(|error| ServicesError::Configuration(format!("HMAC key: {error}")))?;
    mac.update(data);

    Ok(mac.finalize().into_bytes().to_vec())
}

/// `deriveFromSecret(purpose)`: `HMAC-SHA256(SECRET, purpose)`
/// (`src/utils/secret.ts:3-9`).
pub(crate) fn derive_from_secret(secret: &str, purpose: &str) -> Result<Vec<u8>, ServicesError> {
    hmac_sha256(secret.as_bytes(), purpose.as_bytes())
}
