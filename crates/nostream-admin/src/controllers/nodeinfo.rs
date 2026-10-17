//! `nodeinfo-handler.ts`.

use crate::error::AdminError;

/// Phase 1 stub — job 005; will serves the nodeinfo document; see `src/controllers/admin/nodeinfo-handler.ts` or `src/handlers/request-handlers/nodeinfo-handler.ts`.
pub async fn handle() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::controllers::nodeinfo",
    })
}
