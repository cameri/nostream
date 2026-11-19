//! `GET <prefix>/admin/notifications`: the merged notification block with secrets redacted.
//! Mirrors `src/controllers/admin/get-notifications-controller.ts`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::request_context::RequestSettings;
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, json_response};
use crate::state::AdminState;

/// The redacted merged block, as the console reads it.
pub fn redacted_notifications(
    settings: &nostream_config::Settings,
) -> Result<Value, crate::error::AdminError> {
    let configured = settings
        .admin
        .as_ref()
        .and_then(|admin| admin.notifications.clone());
    let merged =
        nostream_config::notifications::get_merged_admin_notifications(configured.as_ref(), None);
    let redacted = nostream_config::notifications::get_redacted_admin_notifications(&merged, None)?;
    serde_json::to_value(redacted).map_err(|error| {
        crate::error::AdminError::Internal(format!("notifications to JSON: {error}"))
    })
}

pub async fn handle(
    State(_state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    RequestSettings(settings): RequestSettings,
) -> HandlerResult {
    let notifications = redacted_notifications(&settings)?;
    Ok(json_response(
        StatusCode::OK,
        &json!({ "notifications": notifications }),
    ))
}
