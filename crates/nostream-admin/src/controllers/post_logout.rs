//! `post-logout-controller.ts`.

use crate::error::AdminError;

/// Phase 1 stub — job 005; will ends the admin session; see `src/controllers/admin/post-logout-controller.ts`.
pub async fn handle() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::controllers::post_logout",
    })
}
