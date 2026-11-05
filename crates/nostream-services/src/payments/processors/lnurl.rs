//! `lnurl-payments-processor.ts`.

use std::sync::Arc;
use std::time::Duration;

use nostream_config::settings::{PaymentsProcessors, Processor};
use nostream_core::random::{RandomSource, SystemRandom};
use nostream_storage::repositories::{Invoice, InvoiceStatus, InvoiceUnit};

use crate::error::ServicesError;
use crate::http::{HttpClient, parse_json};
use crate::payments::{
    InvoiceUpdate, PaymentProcessor, ProcessorFuture, ProcessorInvoice, now, text_field, uuid_v4,
};

/// The timeout a processor request takes when it names none (axios' own default).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The LNURL processor (`src/payments-processors/lnurl-payments-processor.ts`).
pub struct LnurlProcessor {
    http: Arc<dyn HttpClient>,
    invoice_url: String,
    random: Box<dyn RandomSource>,
}

impl LnurlProcessor {
    pub(crate) fn new(
        configured: Option<&PaymentsProcessors>,
        http: Arc<dyn HttpClient>,
    ) -> Result<Box<dyn PaymentProcessor>, ServicesError> {
        let Some(invoice_url) = configured
            .and_then(|configured| configured.lnurl.as_ref())
            .map(|lnurl| lnurl.invoice_url.clone())
        else {
            return Err(ServicesError::Configuration(
                "Unable to create payments processor: Setting paymentsProcessor.lnurl.invoiceURL is not configured."
                    .to_owned(),
            ));
        };

        Ok(Box::new(Self {
            http,
            invoice_url,
            random: Box::new(SystemRandom),
        }))
    }
}

impl PaymentProcessor for LnurlProcessor {
    fn processor(&self) -> Option<Processor> {
        Some(Processor::Lnurl)
    }

    fn create_invoice<'a>(
        &'a self,
        amount_msats: i64,
        description: &'a str,
        request_id: &'a str,
    ) -> ProcessorFuture<'a, ProcessorInvoice> {
        Box::pin(async move {
            let url = format!(
                "{}/callback?amount={amount_msats}&comment={description}",
                self.invoice_url.trim_end_matches('/')
            );
            let response = self.http.get(&url, REQUEST_TIMEOUT).await?;
            let document = parse_json(&response)?;

            Ok(ProcessorInvoice {
                id: uuid_v4(self.random.as_ref())?,
                pubkey: Some(request_id.to_owned()),
                bolt11: text_field(&document, "pr").unwrap_or_default(),
                amount_requested: amount_msats,
                description: description.to_owned(),
                unit: InvoiceUnit::Msats,
                status: InvoiceStatus::Pending,
                expires_at: None,
                confirmed_at: None,
                created_at: Some(now()),
                verify_url: text_field(&document, "verify"),
            })
        })
    }

    fn get_invoice<'a>(&'a self, invoice: &'a Invoice) -> ProcessorFuture<'a, InvoiceUpdate> {
        Box::pin(async move {
            let url = invoice.verify_url.as_deref().ok_or_else(|| {
                ServicesError::Payment(format!("invoice {} has no verify url", invoice.id))
            })?;
            let response = self.http.get(url, REQUEST_TIMEOUT).await?;
            let document = parse_json(&response)?;
            let settled = document
                .get("settled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);

            Ok(InvoiceUpdate {
                id: Some(invoice.id.clone()),
                status: Some(if settled {
                    InvoiceStatus::Completed
                } else {
                    InvoiceStatus::Pending
                }),
                confirmed_at: settled.then(now),
                ..InvoiceUpdate::default()
            })
        })
    }
}
