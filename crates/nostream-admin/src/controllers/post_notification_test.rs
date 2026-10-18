//! `post-notification-test-controller.ts`.

use crate::error::AdminError;

/// Phase 1 stub — job 005; will sends one test notification; see `src/controllers/admin/post-notification-test-controller.ts`.
pub async fn handle() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::controllers::post_notification_test",
    })
}
