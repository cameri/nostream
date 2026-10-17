//! `invoices/index.ts`.

use crate::error::ServicesError;

/// Phase 1 stub — job 005; will the invoice callback route; see `src/controllers/invoices/index.ts`.
pub async fn handle() -> Result<(), ServicesError> {
    Err(ServicesError::NotImplemented {
        module: "services::controllers::invoice_controller",
    })
}
