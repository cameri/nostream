//! `get-readyz-request-handler.ts`.

use crate::error::AdminError;

/// Phase 1 stub — job 005; will reports readiness; see `src/controllers/admin/get-readyz-request-handler.ts` or `src/handlers/request-handlers/get-readyz-request-handler.ts`.
pub async fn handle() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::controllers::get_readyz",
    })
}
