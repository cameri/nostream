//! `GET <prefix>/admin/ops/nip05-verifications`: the verification rows with their pagination.
//! Mirrors `src/controllers/admin/get-ops-nip05-verifications-controller.ts` (Value 20).

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::request_context::{RequestSettings, parse_bool_query};
use crate::controllers::with_admin_controller_request_handler::{
    HandlerResult, error_message, json_response,
};
use crate::state::AdminState;
use crate::utils::nip05::ListQuery;

#[derive(Debug, Clone, Deserialize)]
pub struct Nip05Query {
    pub limit: Option<String>,
    pub offset: Option<String>,
    pub domain: Option<String>,
    pub verified: Option<String>,
    pub stale: Option<String>,
    #[serde(rename = "minFailures")]
    pub min_failures: Option<String>,
    #[serde(rename = "min_failures")]
    pub min_failures_legacy: Option<String>,
}

fn parse_u64(raw: Option<&str>) -> Option<u64> {
    raw.and_then(|value| value.trim().parse::<u64>().ok())
}

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    RequestSettings(settings): RequestSettings,
    Query(query): Query<Nip05Query>,
) -> HandlerResult {
    let min_failures_raw = query
        .min_failures
        .as_deref()
        .or(query.min_failures_legacy.as_deref())
        .filter(|value| !value.is_empty());

    let min_failures = match min_failures_raw {
        None => None,
        Some(raw) => match raw.trim().parse::<u32>() {
            Ok(value) => Some(value),
            Err(_) => {
                return Ok(error_message(
                    StatusCode::BAD_REQUEST,
                    "minFailures must be a non-negative integer",
                ));
            }
        },
    };

    let list_query = ListQuery::from_params(
        parse_u64(query.limit.as_deref()),
        parse_u64(query.offset.as_deref()),
        query.domain.clone(),
        parse_bool_query(query.verified.as_deref()),
        parse_bool_query(query.stale.as_deref()),
        min_failures,
    );

    let (rows, total) = crate::utils::nip05::list_for_admin(&state, &settings, &list_query).await?;
    let verifications = serde_json::to_value(rows)
        .map_err(|error| crate::error::AdminError::Internal(format!("rows to JSON: {error}")))?;
    let verify_expiration_ms = crate::utils::nip05::verify_expiration_ms(&settings);

    Ok(json_response(
        StatusCode::OK,
        &json!({
            "verifications": verifications,
            "pagination": {
                "limit": list_query.limit,
                "offset": list_query.offset,
                "total": total,
            },
            "verifyExpirationMs": verify_expiration_ms,
        }),
    ))
}
