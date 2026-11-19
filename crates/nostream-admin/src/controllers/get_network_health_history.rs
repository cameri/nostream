//! `GET <prefix>/admin/network-health/history`: the probe history ring, newest first. Mirrors
//! `src/controllers/admin/get-network-health-history-controller.ts` (Value 25).

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::request_context::RequestSettings;
use crate::controllers::with_admin_controller_request_handler::{
    HandlerResult, error_message, json_response,
};
use crate::state::{AdminState, ProbeRetention};

/// `DEFAULT_NETWORK_HEALTH_HISTORY_LIMIT`.
pub const DEFAULT_LIMIT: usize = 24;

#[derive(Debug, Clone, Deserialize)]
pub struct HistoryQuery {
    pub limit: Option<String>,
}

/// `parseNetworkHealthHistoryLimit`: absent is 24, anything unparsable or under one is `None`
/// (the caller's 400), and a larger value is capped at 500.
pub fn parse_limit(raw: Option<&str>) -> Option<usize> {
    let Some(raw) = raw else {
        return Some(DEFAULT_LIMIT);
    };
    let parsed = raw.parse::<i64>().ok()?;
    if parsed < 1 {
        return None;
    }
    Some(
        usize::try_from(parsed)
            .unwrap_or(usize::MAX)
            .min(ProbeRetention::MAX_API_LIMIT),
    )
}

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    RequestSettings(settings): RequestSettings,
    Query(query): Query<HistoryQuery>,
) -> HandlerResult {
    let Some(limit) = parse_limit(query.limit.as_deref()) else {
        return Ok(error_message(
            StatusCode::BAD_REQUEST,
            "limit must be a positive integer",
        ));
    };

    let retention = settings
        .nip66
        .as_ref()
        .map(|nip66| ProbeRetention {
            runs: nip66.history_retention_runs,
            hours: nip66.history_retention_hours,
        })
        .unwrap_or(ProbeRetention {
            runs: None,
            hours: None,
        });

    let runs = state.probe_history(limit, retention);
    Ok(json_response(StatusCode::OK, &json!({ "runs": runs })))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn the_limit_is_defaulted_capped_and_validated() {
        assert_eq!(parse_limit(None), Some(24));
        assert_eq!(parse_limit(Some("5")), Some(5));
        assert_eq!(parse_limit(Some("0")), None);
        assert_eq!(parse_limit(Some("-3")), None);
        assert_eq!(parse_limit(Some("soon")), None);
        assert_eq!(parse_limit(Some("100000")), Some(500));
    }
}
