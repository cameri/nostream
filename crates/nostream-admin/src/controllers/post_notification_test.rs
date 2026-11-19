//! `POST <prefix>/admin/notifications/test`: deliver the capture's test envelope to one
//! target. Mirrors `src/controllers/admin/post-notification-test-controller.ts` and
//! `OperatorNotificationService.dispatchTestTarget`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_json_body_middleware::{
    JsonBody, invalid_request, notification_target_id,
};
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::request_context::RequestSettings;
use crate::controllers::with_admin_controller_request_handler::{
    HandlerResult, error_message, json_response,
};
use crate::state::AdminState;

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    RequestSettings(settings): RequestSettings,
    JsonBody(body): JsonBody,
) -> HandlerResult {
    let Some(target_id) = notification_target_id(&body) else {
        return Ok(invalid_request());
    };

    let Some(admin) = settings.admin.as_ref() else {
        return Ok(error_message(
            StatusCode::BAD_GATEWAY,
            &format!("Unknown notification target: {target_id}"),
        ));
    };
    let merged = nostream_config::notifications::get_merged_admin_notifications(
        admin.notifications.as_ref(),
        None,
    );
    let Some(target) = merged.targets.iter().find(|target| target.id == target_id) else {
        return Ok(error_message(
            StatusCode::BAD_GATEWAY,
            &format!("Unknown notification target: {target_id}"),
        ));
    };

    let relay_name = if settings.info.name.trim().is_empty() {
        settings.info.relay_url.clone()
    } else {
        settings.info.name.clone()
    };
    let envelope = nostream_services::services::notification_channels::NotificationEnvelope {
        event: "relay.restarted".to_owned(),
        relay: relay_name.clone(),
        timestamp: crate::state::iso8601(state.clock().now_ms()),
        data: json!({
            "test": true,
            "message": format!("Test notification from {relay_name}"),
        }),
    };

    match nostream_services::services::notification_channels::deliver_to_target(
        target,
        &envelope,
        state.http().as_ref(),
    )
    .await
    {
        Ok(()) => Ok(json_response(StatusCode::OK, &json!({ "ok": true }))),
        Err(error) => {
            tracing::warn!(error = %error, target = target_id, "a test notification failed");
            Ok(error_message(
                StatusCode::BAD_GATEWAY,
                &format!("Delivery failed: {error}"),
            ))
        }
    }
}
