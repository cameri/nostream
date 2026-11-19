//! `GET <prefix>/admin/health`: the health snapshot. Mirrors
//! `src/controllers/admin/get-health-controller.ts` (the admin controller; the non-admin
//! document handler is `get_health.rs` and stays a labelled stub).
//!
//! The console does not call this route; it is registered because the capture registers it
//! (`src/routes/admin/index.ts:64-69`).

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
    let health = crate::utils::health::collect(&state).await;
    let health = serde_json::to_value(&health)
        .map_err(|error| crate::error::AdminError::Internal(format!("health to JSON: {error}")))?;
    Ok(json_response(StatusCode::OK, &json!(health)))
}
