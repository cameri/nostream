//! `opennode-payments-processor.ts` and `fromOpenNodeInvoice`
//! (`src/utils/transform.ts:240-280`).

use std::sync::Arc;
use std::time::Duration;

use nostream_config::settings::{PaymentsProcessors, Processor};
use nostream_storage::repositories::{Invoice, InvoiceStatus, InvoiceUnit};

use crate::error::ServicesError;
use crate::http::{HttpClient, join_url, parse_json, post_json};
use crate::payments::{
    Env, InvoiceUpdate, PaymentProcessor, ProcessorFuture, ProcessorInvoice, from_iso,
    from_unix_seconds, integer_field, now, text_field,
};

/// The timeout a processor request takes when it names none (axios' own default).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The OpenNode processor (`src/payments-processors/opennode-payments-processor.ts`).
pub struct OpennodeProcessor {
    http: Arc<dyn HttpClient>,
    base_url: String,
    callback_base_url: String,
}

impl OpennodeProcessor {
    pub(crate) fn create(
        configured: Option<&PaymentsProcessors>,
        http: Arc<dyn HttpClient>,
        env: &Env<'_>,
    ) -> Result<Box<dyn PaymentProcessor>, ServicesError> {
        let Some(opennode) = configured.and_then(|configured| configured.opennode.as_ref()) else {
            return Err(ServicesError::Configuration(
                "Setting paymentsProcessor.opennode.callbackBaseURL is not configured.".to_owned(),
            ));
        };

        if opennode
            .callback_base_url
            .contains("nostream.your-domain.com")
        {
            return Err(ServicesError::Configuration(
                "Setting paymentsProcessor.opennode.callbackBaseURL is not configured.".to_owned(),
            ));
        }

        if env("OPENNODE_API_KEY").is_none() {
            return Err(ServicesError::Configuration(
                "OPENNODE_API_KEY must be set.".to_owned(),
            ));
        }

        Ok(Box::new(Self {
            http,
            base_url: opennode.base_url.clone(),
            callback_base_url: opennode.callback_base_url.clone(),
        }))
    }
}

/// `fromOpenNodeInvoice` (`src/utils/transform.ts:240-280`).
fn from_opennode_invoice(document: &serde_json::Value) -> Result<ProcessorInvoice, ServicesError> {
    let status = match text_field(document, "status").as_deref() {
        Some("expired" | "refunded") => InvoiceStatus::Expired,
        Some("unpaid" | "processing" | "underpaid") => InvoiceStatus::Pending,
        Some("paid") => InvoiceStatus::Completed,
        Some(other) => {
            return Err(ServicesError::Payment(format!(
                "unknown invoice status: {other}"
            )));
        }
        None => InvoiceStatus::Pending,
    };

    let bolt11 = document
        .get("lightning_invoice")
        .and_then(|invoice| text_field(invoice, "payreq"))
        .or_else(|| {
            document
                .get("lightning")
                .and_then(|lightning| text_field(lightning, "payreq"))
        })
        .unwrap_or_default();

    let expires_at = from_iso(
        document
            .get("lightning")
            .and_then(|lightning| lightning.get("expires_at")),
    )
    .or_else(|| {
        from_unix_seconds(
            document
                .get("lightning_invoice")
                .and_then(|invoice| invoice.get("expires_at"))
                .and_then(serde_json::Value::as_i64),
        )
    });

    let created_at = match document.get("created_at") {
        Some(serde_json::Value::Number(_)) => from_unix_seconds(
            document
                .get("created_at")
                .and_then(serde_json::Value::as_i64),
        ),
        Some(_) => from_iso(document.get("created_at")),
        None => None,
    };

    Ok(ProcessorInvoice {
        id: text_field(document, "id").unwrap_or_default(),
        pubkey: text_field(document, "order_id"),
        bolt11,
        amount_requested: integer_field(document, "amount")
            .or_else(|| integer_field(document, "price"))
            .unwrap_or(0),
        description: text_field(document, "description").unwrap_or_default(),
        unit: InvoiceUnit::Sats,
        status,
        expires_at,
        confirmed_at: (status == InvoiceStatus::Completed).then(now),
        created_at,
        verify_url: None,
    })
}

impl PaymentProcessor for OpennodeProcessor {
    fn processor(&self) -> Option<Processor> {
        Some(Processor::Opennode)
    }

    fn create_invoice<'a>(
        &'a self,
        amount_msats: i64,
        description: &'a str,
        request_id: &'a str,
    ) -> ProcessorFuture<'a, ProcessorInvoice> {
        Box::pin(async move {
            let url = join_url(&self.base_url, "/v1/charges");
            let body = serde_json::json!({
                "amount": amount_msats / 1000,
                "description": description,
                "order_id": request_id,
                "callback_url": self.callback_base_url,
                "ttl": 10,
            });
            let response = post_json(self.http.as_ref(), &url, &body, REQUEST_TIMEOUT).await?;
            let document = parse_json(&response)?;

            from_opennode_invoice(
                document
                    .get("data")
                    .ok_or_else(|| ServicesError::Payment("response has no data".to_owned()))?,
            )
        })
    }

    fn get_invoice<'a>(&'a self, invoice: &'a Invoice) -> ProcessorFuture<'a, InvoiceUpdate> {
        Box::pin(async move {
            let url = join_url(&self.base_url, &format!("/v2/charge/{}", invoice.id));
            let response = self.http.get(&url, REQUEST_TIMEOUT).await?;
            let document = parse_json(&response)?;
            let decoded = from_opennode_invoice(
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
