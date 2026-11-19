//! `POST <prefix>/admin/settings/restore`: restore a named backup. Mirrors
//! `src/controllers/admin/post-settings-restore-controller.ts` — a failure is `400 {"error":…}`
//! with the message the failure carries.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_json_body_middleware::{JsonBody, invalid_request, restore_filename};
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::request_context::{ClientInfo, RequestDocument};
use crate::controllers::with_admin_controller_request_handler::{
    HandlerResult, error_message, json_response,
};
use crate::state::AdminState;

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    client: ClientInfo,
    RequestDocument { defaults, .. }: RequestDocument,
    JsonBody(body): JsonBody,
) -> HandlerResult {
    let Some(filename) = restore_filename(&body) else {
        return Ok(invalid_request());
    };

    match nostream_config::store::restore_backup(
        state.paths(),
        &defaults,
        &filename,
        state.now_utc(),
    ) {
        Ok(_) => {
            let _ = state.append_settings_audit(serde_json::json!({
                "timestamp": crate::state::iso8601(state.clock().now_ms()),
                "action": "settings.restored",
                "filename": filename,
                "remoteAddress": client.address,
            }));
            crate::controllers::post_login::record_audit(
                &state,
                "settings.restored",
                &client.address,
            );
            Ok(json_response(
                StatusCode::OK,
                &serde_json::json!({ "ok": true, "filename": filename }),
            ))
        }
        Err(error) => Ok(error_message(StatusCode::BAD_REQUEST, &error.to_string())),
    }
}
