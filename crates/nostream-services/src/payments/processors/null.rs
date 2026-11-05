//! `null-payments-processor.ts`: the processor a disabled or unknown configuration answers.

use nostream_config::settings::Processor;
use nostream_storage::repositories::{Invoice, InvoiceStatus, InvoiceUnit};

use crate::payments::{InvoiceUpdate, PaymentProcessor, ProcessorFuture, ProcessorInvoice, now};

/// The null processor.
#[derive(Debug, Default, Clone, Copy)]
pub struct NullProcessor;

impl NullProcessor {
    pub(crate) fn new() -> Self {
        Self
    }
}

impl PaymentProcessor for NullProcessor {
    fn processor(&self) -> Option<Processor> {
        None
    }

    fn create_invoice<'a>(
        &'a self,
        _amount_msats: i64,
        _description: &'a str,
        _request_id: &'a str,
    ) -> ProcessorFuture<'a, ProcessorInvoice> {
        Box::pin(async move {
            Ok(ProcessorInvoice {
                id: String::new(),
                pubkey: Some(String::new()),
                bolt11: String::new(),
                amount_requested: 0,
                description: String::new(),
                unit: InvoiceUnit::Msats,
                status: InvoiceStatus::Pending,
                expires_at: Some(now()),
                confirmed_at: None,
                created_at: Some(now()),
                verify_url: Some(String::new()),
            })
        })
    }

    fn get_invoice<'a>(&'a self, invoice: &'a Invoice) -> ProcessorFuture<'a, InvoiceUpdate> {
        Box::pin(async move {
            Ok(InvoiceUpdate {
                id: Some(invoice.id.clone()),
                pubkey: Some(String::new()),
                bolt11: Some(String::new()),
                amount_requested: Some(0),
                amount_paid: None,
                unit: Some(InvoiceUnit::Msats),
                status: Some(InvoiceStatus::Pending),
                description: Some(String::new()),
                confirmed_at: None,
                expires_at: Some(now()),
                created_at: Some(now()),
                verify_url: Some(String::new()),
            })
        })
    }
}
