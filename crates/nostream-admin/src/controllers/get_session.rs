//! `GET <prefix>/admin/session`: the current session's expiry. Mirrors
//! `src/controllers/admin/get-session-controller.ts`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, json_response};
use crate::state::AdminState;

pub async fn handle(
    State(_state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    session: Session,
) -> HandlerResult {
    Ok::<Response, crate::controllers::with_admin_controller_request_handler::HandlerError>(
        json_response(
            StatusCode::OK,
            &json!({ "authenticated": true, "expiresAt": session.expires_at }),
        ),
    )
}
