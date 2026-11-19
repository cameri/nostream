//! `GET <prefix>/admin/moderation/stats`: the panel's activity summary. Mirrors
//! `src/controllers/admin/get-moderation-stats-controller.ts` with D4's answer: the query
//! validation and its message are the capture's, the three aggregates are empty because the
//! store has no grouped aggregation and there is no hit counter.

use std::sync::Arc;

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

/// `ADMIN_MODERATION_STATS_DEFAULT_WINDOW_HOURS`.
pub const DEFAULT_WINDOW_HOURS: i64 = 168;

/// `ADMIN_MODERATION_STATS_MAX_WINDOW_HOURS`.
pub const MAX_WINDOW_HOURS: i64 = 720;

/// `ADMIN_MODERATION_STATS_DEFAULT_LIMIT`.
pub const DEFAULT_LIMIT: u64 = 20;

#[derive(Debug, Clone, Deserialize)]
pub struct StatsQuery {
    #[serde(rename = "windowHours")]
    pub window_hours: Option<String>,
    pub limit: Option<String>,
}

/// `parseModerationStatsWindowHours`: absent or empty is 168; anything else must be an integer
/// in `[1, 720]` or the caller answers 400 with this message.
pub fn parse_window_hours(raw: Option<&str>) -> Result<i64, String> {
    match raw {
        None | Some("") => Ok(DEFAULT_WINDOW_HOURS),
        Some(value) => match value.parse::<i64>() {
            Ok(hours) if (1..=MAX_WINDOW_HOURS).contains(&hours) => Ok(hours),
            _ => Err(format!(
                "windowHours must be an integer between 1 and {MAX_WINDOW_HOURS}"
            )),
        },
    }
}

/// `parseModerationStatsLimit`: an out-of-range or unparsable value falls back to 20.
pub fn parse_stats_limit(raw: Option<&str>) -> u64 {
    match raw {
        None | Some("") => DEFAULT_LIMIT,
        Some(value) => match value.parse::<u64>() {
            Ok(limit) if (1..=100).contains(&limit) => limit,
            _ => DEFAULT_LIMIT,
        },
    }
}

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    Query(query): Query<StatsQuery>,
) -> HandlerResult {
    let hours = match parse_window_hours(query.window_hours.as_deref()) {
        Ok(hours) => hours,
        Err(message) => return Ok(error_message(StatusCode::BAD_REQUEST, &message)),
    };
    let _limit = parse_stats_limit(query.limit.as_deref());
    let since = state.clock().now_secs() - hours * 3_600;

    Ok(json_response(
        StatusCode::OK,
        &json!({
            "windowHours": hours,
            "since": since,
            "topPublishingPubkeys": [],
            "topClientIps": [],
            "rateLimitHits": { "pubkeys": [], "ips": [] },
        }),
    ))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn the_window_is_defaulted_and_bounded() {
        assert_eq!(parse_window_hours(None).unwrap(), 168);
        assert_eq!(parse_window_hours(Some("")).unwrap(), 168);
        assert_eq!(parse_window_hours(Some("24")).unwrap(), 24);
        assert_eq!(
            parse_window_hours(Some("721")).unwrap_err(),
            "windowHours must be an integer between 1 and 720"
        );
        assert!(parse_window_hours(Some("0")).is_err());
        assert!(parse_window_hours(Some("6.5")).is_err());
    }

    #[test]
    fn the_limit_falls_back_outside_its_range() {
        assert_eq!(parse_stats_limit(None), 20);
        assert_eq!(parse_stats_limit(Some("15")), 15);
        assert_eq!(parse_stats_limit(Some("0")), 20);
        assert_eq!(parse_stats_limit(Some("101")), 20);
    }
}
