//! `POST <prefix>/admin/moderation/actions`: apply one of the six actions and persist the
//! resulting limits. Mirrors `src/controllers/admin/post-moderation-actions-controller.ts`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_json_body_middleware::{
    JsonBody, invalid_request, moderation_action, validation_failed,
};
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::request_context::{ClientInfo, RequestDocument};
use crate::controllers::with_admin_controller_request_handler::{
    HandlerResult, error_message, json_response,
};
use crate::state::AdminState;
use crate::utils::moderation::{
    ActionFields, ModerationAction, ModerationError, ModerationLimits, apply_action, normalize,
    read_limits, validation_issues, write_limits,
};

/// Writes the limits into the user document, validates the merged result, saves it with a
/// backup, and records both audits.
pub fn persist(
    state: &AdminState,
    defaults: &serde_yaml::Value,
    limits: &ModerationLimits,
    action: &str,
    detail: serde_json::Value,
    remote_address: &str,
) -> Result<(), ModerationError> {
    let normalized = normalize(limits)?;
    let user = write_limits(
        &state.user_document().map_err(|error| {
            ModerationError::Message(format!("the settings could not be read: {error}"))
        })?,
        &normalized,
    );
    let merged = nostream_config::merge(defaults, &user);
    let issues = validation_issues(&merged, defaults);
    if !issues.is_empty() {
        return Err(ModerationError::Validation(issues));
    }

    state.save_user_settings(&user).map_err(|error| {
        ModerationError::Message(format!("the settings could not be written: {error}"))
    })?;
    let _ = state.append_settings_audit(json!({
        "timestamp": crate::state::iso8601(state.clock().now_ms()),
        "action": "settings.updated",
        "changes": [
            { "path": "limits.event.pubkey", "reload": "hot-reload" },
            { "path": "limits.event.kind", "reload": "hot-reload" },
            { "path": "limits.event.whitelists", "reload": "hot-reload" },
        ],
        "remoteAddress": remote_address,
    }));
    crate::controllers::post_login::record_audit(state, action, remote_address);
    if !detail.is_null() {
        let _ = state.append_audit(action, Some(remote_address), Some(detail));
    }
    Ok(())
}

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    client: ClientInfo,
    RequestDocument { merged, defaults }: RequestDocument,
    JsonBody(body): JsonBody,
) -> HandlerResult {
    let Some((action, pubkey, ip)) = moderation_action(&body) else {
        return Ok(invalid_request());
    };
    let Some(action) = ModerationAction::parse(&action) else {
        return Ok(invalid_request());
    };

    let current = read_limits(&merged);
    let fields = ActionFields { pubkey, ip };
    let next = match apply_action(&current, action, &fields) {
        Ok(next) => next,
        Err(error) => return Ok(moderation_error_response(error)),
    };

    let detail = json!({
        "action": action.as_str(),
        "pubkey": fields.pubkey,
        "ip": fields.ip,
    });
    if let Err(error) = persist(
        &state,
        &defaults,
        &next,
        "moderation.action",
        detail,
        &client.address,
    ) {
        return Ok(moderation_error_response(error));
    }
    state
        .enqueue_notification("moderation.action", json!({ "action": action.as_str() }))
        .await;

    Ok(json_response(
        StatusCode::OK,
        &json!({ "ok": true, "limits": next }),
    ))
}

/// The capture's two failure shapes: `Validation failed` with issues, or a bare message.
pub fn moderation_error_response(error: ModerationError) -> axum::response::Response {
    match error {
        ModerationError::Validation(issues) => validation_failed(&issues),
        ModerationError::Message(message) => error_message(StatusCode::BAD_REQUEST, &message),
    }
}
