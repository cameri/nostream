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

    // The capture issues these with `Promise.all` under one 5,000 ms deadline; the queries are
    // futures, so issuing them together costs a gather and keeps the deadline the test proves.
    let events = Arc::clone(&state.stores().events);
    let pending = build_filters(&parsed).into_iter().map(|filter| {
        let events = Arc::clone(&events);
        async move {
            let kinds: Vec<u64> = filter
                .kinds
                .as_ref()
                .map(|kinds| kinds.iter().map(|kind| kind.0).collect())
                .unwrap_or_default();
            let count = events.count_by_filters(std::slice::from_ref(&filter)).await;
            (kinds, count)
        }
    });

    let results = match tokio::time::timeout(
        Duration::from_millis(QUERY_TIMEOUT_MS),
        futures_util::future::join_all(pending),
    )
    .await
    {
        Ok(results) => results,
        Err(_) => {
            return Ok(error_message(
                StatusCode::GATEWAY_TIMEOUT,
                "Storage count query timed out",
            ));
        }
    };

    let mut counts = Vec::with_capacity(results.len());
    for (kinds, count) in results {
        match count {
            Ok(count) => counts.push(json!({ "kinds": kinds, "count": count })),
            Err(error) => {
                tracing::error!(error = %error, "the storage count query failed");
                return Ok(error_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Storage count query failed",
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
