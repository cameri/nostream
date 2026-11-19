//! `PATCH <prefix>/admin/notifications`: merge the patch, validate, save, audit, enqueue.
//! Mirrors `src/controllers/admin/patch-notifications-controller.ts`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_json_body_middleware::{
    JsonBody, invalid_request, notification_patch, validation_failed,
};
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::request_context::ClientInfo;
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, json_response};
use crate::state::AdminState;

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    client: ClientInfo,
    JsonBody(body): JsonBody,
) -> HandlerResult {
    let Some(patch_value) = notification_patch(&body) else {
        return Ok(invalid_request());
    };
    let patch: nostream_config::notifications::AdminNotificationsPatch =
        match serde_json::from_value(patch_value) {
            Ok(patch) => patch,
            Err(_) => return Ok(invalid_request()),
        };

    // The whole read → merge → validate → write sequence runs under the settings write lock.
    let _guard = state.lock_settings().await;
    let settings = state.settings()?;
    let defaults = state.defaults_document()?;
    let configured = settings
        .admin
        .as_ref()
        .and_then(|admin| admin.notifications.clone());
    let current =
        nostream_config::notifications::get_merged_admin_notifications(configured.as_ref(), None);
    let next = nostream_config::notifications::merge_admin_notifications_patch(&current, &patch);

    let next_document = serde_yaml::to_value(&next).map_err(|error| {
        crate::error::AdminError::Internal(format!("notifications to YAML: {error}"))
    })?;
    let user = nostream_config::path::set_by_path(
        &state.user_document()?,
        "admin.notifications",
        next_document,
    )
    .map_err(|error| crate::error::AdminError::Internal(format!("admin.notifications: {error}")))?;

    let merged_next = nostream_config::merge(&defaults, &user);
    let issues = nostream_config::validate_document(&merged_next, &defaults);
    if !issues.is_empty() {
        return Ok(validation_failed(&issues));
    }

    state.save_user_settings(&user)?;
    let _ = state.append_settings_audit(json!({
        "timestamp": crate::state::iso8601(state.clock().now_ms()),
        "action": "settings.updated",
        "changes": [{ "path": "admin.notifications", "reload": "hot-reload" }],
        "remoteAddress": client.address,
    }));
    crate::controllers::post_login::record_audit(
        &state,
        "notifications.updated",
        &client.address,
        None,
    );
    state
        .enqueue_settings_changed(json!({
            "changes": [{ "path": "admin.notifications", "reload": "hot-reload" }],
            "remoteAddress": client.address,
        }))
        .await;

    let settings = state.settings()?;
    let notifications = crate::controllers::get_notifications::redacted_notifications(&settings)?;
    Ok(json_response(
        StatusCode::OK,
        &json!({ "ok": true, "notifications": notifications }),
    ))
}
