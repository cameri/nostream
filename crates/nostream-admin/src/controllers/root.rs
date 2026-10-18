//! `root-request-handler.ts`.

use crate::error::AdminError;

/// Phase 1 stub — job 005; will serves the relay root document; see `src/controllers/admin/root-request-handler.ts` or `src/handlers/request-handlers/root-request-handler.ts`.
pub async fn handle() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::controllers::root",
    })
}
