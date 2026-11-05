//! `invoices/index.ts`.

use crate::error::ServicesError;

/// Phase 2 stub — issue #867; will serve the invoice callback route; see `src/controllers/invoices/index.ts`.
pub async fn handle() -> Result<(), ServicesError> {
    Err(ServicesError::NotImplemented {
        module: "services::controllers::invoice_controller",
    })
}
