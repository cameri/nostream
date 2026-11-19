//! `GET <prefix>/admin/ops/workers`: the configured workers merged with their heartbeats.
//! Mirrors `src/controllers/admin/get-ops-workers-controller.ts` (Value 40, D2, R11).

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::request_context::RequestSettings;
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, json_response};
use crate::state::AdminState;

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    RequestSettings(settings): RequestSettings,
) -> HandlerResult {
    let workers = crate::utils::workers::rows(&state, &settings);
    let workers = serde_json::to_value(workers)
        .map_err(|error| crate::error::AdminError::Internal(format!("workers to JSON: {error}")))?;
    Ok(json_response(
        StatusCode::OK,
        &json!({ "workers": workers }),
    ))
}
