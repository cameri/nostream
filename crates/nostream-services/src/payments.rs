//! The payment-processor seam. Mirrors `src/payments-processors/*-payment(s)-processor.ts`
//! and `src/@types/settings.ts` `keyof PaymentsProcessors`.

use nostream_config::settings::Processor;

use crate::error::ServicesError;

/// One invoice as the processors see it (`src/@types/invoice.ts` shape).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessorInvoice {
    pub id: String,
    pub amount_msats: i64,
    pub description: String,
    pub invoice: String,
    pub expiry_seconds: Option<u64>,
}

/// What every processor implements, one variant per `keyof PaymentsProcessors`.
pub trait PaymentProcessor: Send + Sync + 'static {
    /// The processor this implementation serves.
    fn processor(&self) -> Processor;

    /// Creates an invoice for an admission/publication fee.
    ///
    /// Phase 1 stub — job 005; will create an invoice through the processor's API; see `src/payments-processors/`.
    fn create_invoice(
        &self,
        amount_msats: i64,
        description: &str,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<ProcessorInvoice, ServicesError>> + Send>>;
}

/// Phase 1 stub — job 005; will resolve the processor named by settings; see `src/factories/payments-processors/`.
pub fn resolve(_processor: Processor) -> Result<Box<dyn PaymentProcessor>, ServicesError> {
    Err(ServicesError::NotImplemented {
        module: "services::payments::resolve",
    })
}
