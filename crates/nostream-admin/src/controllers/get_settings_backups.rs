//! `GET <prefix>/admin/settings/backups`: the backups directory, newest first. Mirrors
//! `src/controllers/admin/get-settings-backups-controller.ts`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, json_response};
use crate::state::AdminState;

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
) -> HandlerResult {
    let backups = nostream_config::store::list_backups(state.paths())?;
    let backups = serde_json::to_value(backups)
        .map_err(|error| crate::error::AdminError::Internal(format!("backups to JSON: {error}")))?;

    Ok(json_response(
        StatusCode::OK,
        &serde_json::json!({ "backups": backups }),
    ))
}
