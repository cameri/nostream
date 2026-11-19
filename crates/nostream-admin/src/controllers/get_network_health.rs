//! `GET <prefix>/admin/network-health`: the latest probe snapshot, or `null`. Mirrors
//! `src/controllers/admin/get-network-health-controller.ts` with D3's answer: no run is
//! recorded in this slice, so the console gets its empty state.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, json_response};
use crate::state::AdminState;

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
) -> HandlerResult {
    Ok(json_response(
        StatusCode::OK,
        &json!({ "snapshot": state.latest_probe_snapshot() }),
    ))
}
