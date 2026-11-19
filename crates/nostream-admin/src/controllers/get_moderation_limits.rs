//! `GET <prefix>/admin/moderation/limits`: the event limits the moderation panel edits.
//! Mirrors `src/controllers/admin/get-moderation-limits-controller.ts` (Value 32).

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::request_context::RequestDocument;
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, json_response};
use crate::state::AdminState;

pub async fn handle(
    State(_state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    RequestDocument { merged, .. }: RequestDocument,
) -> HandlerResult {
    let limits = crate::utils::moderation::read_limits(&merged);
    let limits = serde_json::to_value(&limits)
        .map_err(|error| crate::error::AdminError::Internal(format!("limits to JSON: {error}")))?;
    Ok(json_response(StatusCode::OK, &json!({ "limits": limits })))
}
