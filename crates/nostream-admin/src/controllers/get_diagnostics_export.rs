//! `GET <prefix>/admin/diagnostics/export`: the diagnostics blob, inline or as an attachment.
//! Mirrors `src/controllers/admin/get-admin-diagnostics-export-controller.ts` (Value 24).

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderName, StatusCode};
use serde::Deserialize;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::with_admin_controller_request_handler::{
    HandlerResult, json_response, json_response_with_header,
};
use crate::state::AdminState;

#[derive(Debug, Clone, Deserialize)]
pub struct ExportQuery {
    pub download: Option<String>,
}

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    Query(query): Query<ExportQuery>,
) -> HandlerResult {
    let payload = crate::utils::diagnostics::build(&state).await?;

    let download = matches!(query.download.as_deref(), Some("1") | Some("true"));
    if download {
        let stamp = payload["generatedAt"]
            .as_str()
            .unwrap_or_default()
            .replace([':', '.'], "-");
        let disposition = format!("attachment; filename=\"nostream-diagnostics-{stamp}.json\"");
        return Ok(json_response_with_header(
            StatusCode::OK,
            &payload,
            HeaderName::from_static("content-disposition"),
            &disposition,
        ));
    }

    Ok(json_response(StatusCode::OK, &payload))
}
