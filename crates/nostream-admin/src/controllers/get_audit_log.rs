//! `GET <prefix>/admin/audit-log`: the admin audit file, newest first, clamped to `[1, 500]`
//! with a default of 100. Mirrors `src/controllers/admin/get-admin-audit-log-controller.ts`.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, json_response};
use crate::state::AdminState;

/// `DEFAULT_ADMIN_AUDIT_API_LIMIT` — the default page the console asks for.
pub const DEFAULT_LIMIT: u64 = 100;

#[derive(Debug, Clone, Deserialize)]
pub struct AuditQuery {
    pub limit: Option<String>,
}

/// `Number(request.query.limit ?? 100)`, then `min(max(floor(limit), 1), 500)`; a value that is
/// not a finite number keeps the default.
pub fn parse_limit(raw: Option<&str>) -> u64 {
    let Some(raw) = raw else {
        return DEFAULT_LIMIT;
    };
    match raw.trim().parse::<f64>() {
        Ok(parsed) if parsed.is_finite() => {
            let floored = parsed.floor();
            let clamped = floored.clamp(1.0, 500.0);
            clamped as u64
        }
        _ => DEFAULT_LIMIT,
    }
}

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    Query(query): Query<AuditQuery>,
) -> HandlerResult {
    let entries = state.audit_entries(parse_limit(query.limit.as_deref()))?;
    Ok(json_response(
        StatusCode::OK,
        &json!({ "entries": entries }),
    ))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn the_limit_is_clamped_to_the_capture_s_range() {
        assert_eq!(parse_limit(None), 100);
        assert_eq!(parse_limit(Some("0")), 1);
        assert_eq!(parse_limit(Some("1000000000")), 500);
        assert_eq!(parse_limit(Some("12.7")), 12);
        assert_eq!(parse_limit(Some("nope")), 100);
    }
}
