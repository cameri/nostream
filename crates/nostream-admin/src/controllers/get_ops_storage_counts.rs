//! `GET <prefix>/admin/ops/storage/counts`: one count per kind over a bounded window.
//! Mirrors `src/controllers/admin/get-ops-storage-counts-controller.ts` (Value 22, Value 43).

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::with_admin_controller_request_handler::{
    HandlerResult, error_message, json_response,
};
use crate::state::AdminState;
use crate::utils::storage::{QUERY_TIMEOUT_MS, build_filters, parse_query};

#[derive(Debug, Clone, Deserialize)]
pub struct CountsQuery {
    pub kinds: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
}

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    Query(query): Query<CountsQuery>,
) -> HandlerResult {
    let parsed = match parse_query(
        query.kinds.as_deref(),
        query.since.as_deref(),
        query.until.as_deref(),
        state.clock().now_secs(),
    ) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(error_message(StatusCode::BAD_REQUEST, &message)),
    };

    let mut counts = Vec::new();
    for filter in build_filters(&parsed) {
        let kinds: Vec<u64> = filter
            .kinds
            .as_ref()
            .map(|kinds| kinds.iter().map(|kind| kind.0).collect())
            .unwrap_or_default();
        let query = state
            .stores()
            .events
            .count_by_filters(std::slice::from_ref(&filter));

        match tokio::time::timeout(Duration::from_millis(QUERY_TIMEOUT_MS), query).await {
            Ok(Ok(count)) => counts.push(json!({ "kinds": kinds, "count": count })),
            Ok(Err(error)) => {
                tracing::error!(error = %error, "the storage count query failed");
                return Ok(error_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Storage count query failed",
                ));
            }
            Err(_) => {
                return Ok(error_message(
                    StatusCode::GATEWAY_TIMEOUT,
                    "Storage count query timed out",
                ));
            }
        }
    }

    Ok(json_response(
        StatusCode::OK,
        &json!({
            "since": parsed.since,
            "until": parsed.until,
            "counts": counts,
        }),
    ))
}
