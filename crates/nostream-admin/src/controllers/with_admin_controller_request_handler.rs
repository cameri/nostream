//! `with-admin-controller-request-handler.ts`.

use crate::error::AdminError;

/// Phase 1 stub — job 005; will wraps an admin controller with the shared request plumbing; see `src/handlers/request-handlers/with-admin-controller-request-handler.ts`.
pub async fn handle() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::controllers::with_admin_controller_request_handler",
    })
}
