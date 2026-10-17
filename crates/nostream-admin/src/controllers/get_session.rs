//! `get-session-controller.ts`.

use crate::error::AdminError;

/// Phase 1 stub — job 005; will returns the current admin session; see `src/controllers/admin/get-session-controller.ts`.
pub async fn handle() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::controllers::get_session",
    })
}
