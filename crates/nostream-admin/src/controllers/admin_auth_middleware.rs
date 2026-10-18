//! `admin-auth-middleware.ts`.

use crate::error::AdminError;

/// Phase 1 stub — job 005; will authenticates admin requests; see `src/controllers/admin/admin-auth-middleware.ts` or `src/handlers/request-handlers/admin-auth-middleware.ts`.
pub async fn handle() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::controllers::admin_auth_middleware",
    })
}
