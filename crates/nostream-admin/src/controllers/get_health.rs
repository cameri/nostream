//! `get-health-request-handler.ts`.

use crate::error::AdminError;

/// Phase 1 stub — job 005; will reports the relay health payload; see `src/controllers/admin/get-health-request-handler.ts` or `src/handlers/request-handlers/get-health-request-handler.ts`.
pub async fn handle() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::controllers::get_health",
    })
}
