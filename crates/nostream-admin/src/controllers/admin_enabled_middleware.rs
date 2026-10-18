//! `admin-enabled-middleware.ts`.

use crate::error::AdminError;

/// Phase 1 stub — job 005; will gates the admin surface on the feature flag; see `src/handlers/request-handlers/admin-enabled-middleware.ts`.
pub async fn handle() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::controllers::admin_enabled_middleware",
    })
}
