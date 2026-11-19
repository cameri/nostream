//! `GET <prefix>/admin/settings`: the merged document narrowed to the defaults' keys and
//! redacted. Mirrors `src/controllers/admin/get-settings-controller.ts`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::request_context::RequestDocument;
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, json_response};
use crate::state::AdminState;

pub async fn handle(
    State(_state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    RequestDocument { merged, defaults }: RequestDocument,
) -> HandlerResult {
    // Value 52: a key the defaults lack is dropped, except a `passwordHash` subtree.
    let filtered = nostream_config::store::filter_against_defaults(&merged, &defaults);
    let redacted = nostream_config::redaction::redact_settings_secrets(&filtered);
    let settings = serde_json::to_value(redacted).map_err(|error| {
        crate::error::AdminError::Internal(format!("settings to JSON: {error}"))
    })?;

    Ok(json_response(
        StatusCode::OK,
        &serde_json::json!({ "settings": settings }),
    ))
}
