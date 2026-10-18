//! `admin-rate-limit-middleware.ts`.

use crate::error::AdminError;

/// Phase 1 stub — job 005; will rate-limits admin requests; see `src/controllers/admin/admin-rate-limit-middleware.ts` or `src/handlers/request-handlers/admin-rate-limit-middleware.ts`.
pub async fn handle() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::controllers::admin_rate_limit_middleware",
    })
}
