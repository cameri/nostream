//! `lnbits-payment-processor.ts`.

use std::sync::Arc;
use std::time::Duration;

use nostream_config::settings::{PaymentsProcessors, Processor};
use nostream_storage::repositories::{Invoice, InvoiceStatus, InvoiceUnit};

use crate::error::ServicesError;
use crate::http::{HttpClient, join_url, parse_json, post_json};
use crate::payments::{
    Env, InvoiceUpdate, PaymentProcessor, ProcessorFuture, ProcessorInvoice, derive_from_secret,
    from_seconds_or_iso, hmac_sha256, now, parse_unit, text_field,
};

/// The timeout a processor request takes when it names none (axios' own default).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The callback HMAC's validity window, one day (`src/payments-processors/lnbits-payment-processor.ts:94`).
const CALLBACK_HMAC_TTL_MS: i64 = 86_400_000;

/// The LNbits processor (`src/payments-processors/lnbits-payment-processor.ts`).
pub struct LnbitsProcessor {
    http: Arc<dyn HttpClient>,
    base_url: String,
    callback_base_url: String,
    secret: Option<String>,
    headers: Vec<(String, String)>,
}

impl LnbitsProcessor {
    pub(crate) fn create(
        configured: Option<&PaymentsProcessors>,
        http: Arc<dyn HttpClient>,
        env: &Env<'_>,
    ) -> Result<Box<dyn PaymentProcessor>, ServicesError> {
        let Some(lnbits) = configured.and_then(|configured| configured.lnbits.as_ref()) else {
            return Err(ServicesError::Configuration(
                "Setting paymentsProcessor.lnbits.callbackBaseURL is not configured.".to_owned(),
            ));
        };

        if lnbits
            .callback_base_url
            .contains("nostream.your-domain.com")
        {
            return Err(ServicesError::Configuration(
                "Setting paymentsProcessor.lnbits.callbackBaseURL is not configured.".to_owned(),
            ));
        }

        let Some(api_key) = env("LNBITS_API_KEY") else {
            return Err(ServicesError::Configuration(
                "LNBITS_API_KEY must be set to an invoice or admin key.".to_owned(),
            ));
        };

        Ok(Box::new(Self {
            http,
            base_url: lnbits.base_url.clone(),
            callback_base_url: lnbits.callback_base_url.clone(),
            secret: env("SECRET"),
            headers: vec![("x-api-key".to_owned(), api_key)],
        }))
    }

    /// The `webhook` query parameter: the expiry in milliseconds and the HMAC over it
    /// (`src/payments-processors/lnbits-payment-processor.ts:94-98`).
    fn webhook(&self, expires_ms: i64) -> Result<String, ServicesError> {
        let secret = self.secret.as_deref().ok_or_else(|| {
            ServicesError::Payment("SECRET environment variable not set".to_owned())
        })?;
        let derived = derive_from_secret(secret, "lnbits-callback-hmac-key")?;
        let hmac = hex::encode(hmac_sha256(&derived, expires_ms.to_string().as_bytes())?);
        let separator = if self.callback_base_url.contains('?') {
            '&'
        } else {
            '?'
        };

        // `URLSearchParams` percent-encodes the colon, which a callback decodes before
        // verifying the HMAC.
        Ok(format!(
            "{}{separator}hmac={expires_ms}%3A{hmac}",
            self.callback_base_url
        ))
    }
}

/// One LNbits invoice document (`data.details`), for a create or a lookup.
fn from_details(
    details: &serde_json::Value,
    paid: bool,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<ProcessorInvoice, ServicesError> {
    let expires_at = from_seconds_or_iso(details.get("expiry"));
    let status = if paid {
        InvoiceStatus::Completed
    } else if crate::invoice::is_expired_invoice(expires_at, now) {
        InvoiceStatus::Expired
    } else {
        InvoiceStatus::Pending
    };

    Ok(ProcessorInvoice {
        id: text_field(details, "payment_hash").unwrap_or_default(),
        pubkey: details
            .get("extra")
            .and_then(|extra| text_field(extra, "internalId")),
        bolt11: text_field(details, "bolt11").unwrap_or_default(),
        amount_requested: details
            .get("amount")
            .and_then(serde_json::Value::as_f64)
            .map(|amount| (amount / 1000.0) as i64)
            .unwrap_or(0),
        description: text_field(details, "memo").unwrap_or_default(),
        unit: parse_unit("sats")?,
        status,
        expires_at,
        confirmed_at: paid
            .then(|| from_seconds_or_iso(details.get("time")))
            .flatten(),
        created_at: from_seconds_or_iso(details.get("time")),
        verify_url: None,
    })
}

impl PaymentProcessor for LnbitsProcessor {
    fn processor(&self) -> Option<Processor> {
        Some(Processor::Lnbits)
    }

    fn create_invoice<'a>(
        &'a self,
        amount_msats: i64,
        description: &'a str,
        request_id: &'a str,
    ) -> ProcessorFuture<'a, ProcessorInvoice> {
        Box::pin(async move {
            let webhook = self.webhook(now().timestamp_millis() + CALLBACK_HMAC_TTL_MS)?;
            let url = join_url(&self.base_url, "/api/v1/payments");
            let body = serde_json::json!({
                "amount": amount_msats / 1000,
                "memo": description,
                "extra": { "internalId": request_id },
                "out": false,
                "webhook": webhook,
            });

            let response = post_json(
                self.http.as_ref(),
                &url,
                &self.headers,
                &body,
                REQUEST_TIMEOUT,
            )
            .await?;
            let created = parse_json(&response)?;
            let payment_hash = text_field(&created, "payment_hash")
                .ok_or_else(|| ServicesError::Payment("response has no payment_hash".to_owned()))?;

            let url = join_url(&self.base_url, &format!("/api/v1/payments/{payment_hash}"));
            let response = self.http.get(&url, &self.headers, REQUEST_TIMEOUT).await?;
            let document = parse_json(&response)?;
            let details = document
                .get("details")
                .ok_or_else(|| ServicesError::Payment("response has no details".to_owned()))?;

            from_details(
                details,
                document
                    .get("paid")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                now(),
            )
        })
    }

    fn get_invoice<'a>(&'a self, invoice: &'a Invoice) -> ProcessorFuture<'a, InvoiceUpdate> {
        Box::pin(async move {
            let url = join_url(&self.base_url, &format!("/api/v1/payments/{}", invoice.id));
            let response = self.http.get(&url, &self.headers, REQUEST_TIMEOUT).await?;
            let document = parse_json(&response)?;
            let details = document
                .get("details")
                .ok_or_else(|| ServicesError::Payment("response has no details".to_owned()))?;
            let paid = document
                .get("paid")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let decoded = from_details(details, paid, now())?;

            Ok(InvoiceUpdate {
                id: Some(decoded.id),
                pubkey: decoded.pubkey,
                bolt11: Some(decoded.bolt11),
                amount_requested: Some(decoded.amount_requested),
                amount_paid: paid.then_some(decoded.amount_requested),
                unit: Some(InvoiceUnit::Sats),
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
