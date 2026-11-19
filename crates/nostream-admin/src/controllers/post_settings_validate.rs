//! `POST <prefix>/admin/settings/validate`: the merged document's validation findings. Mirrors
//! `src/controllers/admin/post-settings-validate-controller.ts`.

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
    let issues = nostream_config::validate_document(&merged, &defaults);
    let issues: Vec<serde_json::Value> = issues
        .iter()
        .map(|issue| serde_json::json!({ "path": issue.path, "message": issue.message }))
        .collect();

    Ok(json_response(
        StatusCode::OK,
        &serde_json::json!({ "valid": issues.is_empty(), "issues": issues }),
    ))
}
