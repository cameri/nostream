//! `get-admin-dashboard-request-handler.ts`.

use crate::error::AdminError;

/// Phase 1 stub — job 005; will render the admin dashboard; see
/// `src/handlers/request-handlers/get-admin-dashboard-request-handler.ts`.
pub async fn handle() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::controllers::get_dashboard",
    })
}
