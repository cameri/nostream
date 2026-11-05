//! `zebedee-payments-processor.ts` and `fromZebedeeInvoice` (`src/utils/transform.ts:194-206`).

use std::sync::Arc;
use std::time::Duration;

use nostream_config::settings::{PaymentsProcessors, Processor};
use nostream_storage::repositories::Invoice;

use crate::error::ServicesError;
use crate::http::{HttpClient, join_url, parse_json, post_json};
use crate::payments::{
    Env, InvoiceUpdate, PaymentProcessor, ProcessorFuture, ProcessorInvoice, from_iso,
    integer_field, parse_status, parse_unit, text_field,
};

/// The timeout a processor request takes when it names none (axios' own default).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The Zebedee processor (`src/payments-processors/zebedee-payments-processor.ts`).
pub struct ZebedeeProcessor {
    http: Arc<dyn HttpClient>,
    base_url: String,
    callback_base_url: String,
    headers: Vec<(String, String)>,
}

impl ZebedeeProcessor {
    pub(crate) fn create(
        configured: Option<&PaymentsProcessors>,
        http: Arc<dyn HttpClient>,
        env: &Env<'_>,
    ) -> Result<Box<dyn PaymentProcessor>, ServicesError> {
        let Some(zebedee) = configured.and_then(|configured| configured.zebedee.as_ref()) else {
            return Err(ServicesError::Configuration(
                "Setting paymentsProcessor.zebedee.callbackBaseURL is not configured.".to_owned(),
            ));
        };

        if zebedee
            .callback_base_url
            .contains("nostream.your-domain.com")
        {
            return Err(ServicesError::Configuration(
                "Setting paymentsProcessor.zebedee.callbackBaseURL is not configured.".to_owned(),
            ));
        }

        if zebedee.ip_whitelist.is_empty() {
            return Err(ServicesError::Configuration(
                "Setting paymentsProcessor.zebedee.ipWhitelist is empty.".to_owned(),
            ));
        }

        let Some(api_key) = env("ZEBEDEE_API_KEY") else {
            return Err(ServicesError::Configuration(
                "ZEBEDEE_API_KEY must be set.".to_owned(),
            ));
        };

        Ok(Box::new(Self {
            http,
            base_url: zebedee.base_url.clone(),
            callback_base_url: zebedee.callback_base_url.clone(),
            headers: vec![("apikey".to_owned(), api_key)],
        }))
    }
}

/// `fromZebedeeInvoice`: every field verbatim from the provider
/// (`src/utils/transform.ts:194-206`).
fn from_zebedee_invoice(document: &serde_json::Value) -> Result<ProcessorInvoice, ServicesError> {
    Ok(ProcessorInvoice {
        id: text_field(document, "id").unwrap_or_default(),
        pubkey: text_field(document, "internalId"),
        bolt11: document
            .get("invoice")
            .and_then(|invoice| text_field(invoice, "request"))
            .unwrap_or_default(),
        amount_requested: integer_field(document, "amount").unwrap_or(0),
        description: text_field(document, "description").unwrap_or_default(),
        unit: parse_unit(&text_field(document, "unit").unwrap_or_default())?,
        status: parse_status(&text_field(document, "status").unwrap_or_default())?,
        expires_at: from_iso(document.get("expiresAt")),
        confirmed_at: from_iso(document.get("confirmedAt")),
        created_at: from_iso(document.get("createdAt")),
        verify_url: None,
    })
}

impl PaymentProcessor for ZebedeeProcessor {
    fn processor(&self) -> Option<Processor> {
        Some(Processor::Zebedee)
    }

    fn create_invoice<'a>(
        &'a self,
        amount_msats: i64,
        description: &'a str,
        request_id: &'a str,
    ) -> ProcessorFuture<'a, ProcessorInvoice> {
        Box::pin(async move {
            let url = join_url(&self.base_url, "/v0/charges");
            let body = serde_json::json!({
                "amount": amount_msats.to_string(),
                "description": description,
                "internalId": request_id,
                "callbackUrl": self.callback_base_url,
            });
            let response = post_json(
                self.http.as_ref(),
                &url,
                &self.headers,
                &body,
                REQUEST_TIMEOUT,
            )
            .await?;
            let document = parse_json(&response)?;

            from_zebedee_invoice(
                document
                    .get("data")
                    .ok_or_else(|| ServicesError::Payment("response has no data".to_owned()))?,
            )
        })
    }

    fn get_invoice<'a>(&'a self, invoice: &'a Invoice) -> ProcessorFuture<'a, InvoiceUpdate> {
        Box::pin(async move {
            let url = join_url(&self.base_url, &format!("/v0/charges/{}", invoice.id));
            let response = self.http.get(&url, &self.headers, REQUEST_TIMEOUT).await?;
            let document = parse_json(&response)?;
            let decoded = from_zebedee_invoice(
                document
                    .get("data")
                    .ok_or_else(|| ServicesError::Payment("response has no data".to_owned()))?,
            )?;

            Ok(InvoiceUpdate {
                id: Some(decoded.id),
                pubkey: decoded.pubkey,
                bolt11: Some(decoded.bolt11),
                amount_requested: Some(decoded.amount_requested),
                amount_paid: None,
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
