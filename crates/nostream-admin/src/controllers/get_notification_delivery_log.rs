//! `GET <prefix>/admin/notifications/deliveries`: the delivery log, newest first. Mirrors
//! `src/controllers/admin/get-notification-delivery-log-controller.ts` (Value 19).

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

/// The query string.
#[derive(Debug, Clone, Deserialize)]
pub struct DeliveryLogQuery {
    pub limit: Option<String>,
    pub status: Option<String>,
    #[serde(rename = "eventType")]
    pub event_type: Option<String>,
}

/// `DEFAULT_DELIVERY_LOG_LIMIT`.
pub const DEFAULT_LIMIT: u64 = 50;

/// `MAX_DELIVERY_LOG_LIMIT`.
pub const MAX_LIMIT: u64 = 500;

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    Query(query): Query<DeliveryLogQuery>,
) -> HandlerResult {
    let mut limit = DEFAULT_LIMIT;
    if let Some(raw) = query.limit.as_deref() {
        match raw.parse::<i64>() {
            Ok(parsed) if parsed > 0 => limit = (parsed as u64).min(MAX_LIMIT),
            _ => {
                return Ok(error_message(
                    StatusCode::BAD_REQUEST,
                    "limit must be a positive integer",
                ));
            }
        }
    }

    let status = match query.status.as_deref() {
        None => None,
        Some("success") => {
            Some(nostream_storage::repositories::NotificationDeliveryStatus::Success)
        }
        Some("failed") => Some(nostream_storage::repositories::NotificationDeliveryStatus::Failed),
        Some(_) => {
            return Ok(error_message(
                StatusCode::BAD_REQUEST,
                "status must be success or failed",
            ));
        }
    };

    let event_type = match query.event_type.as_deref() {
        None => None,
        Some(raw) if raw.trim().is_empty() => {
            return Ok(error_message(
                StatusCode::BAD_REQUEST,
                "eventType must be non-empty",
            ));
        }
        Some(raw) => Some(raw.trim().to_owned()),
    };

    let filters = nostream_storage::repositories::DeliveryLogFilters { status, event_type };
    let entries = state
        .stores()
        .notification_delivery_log
        .find_recent(limit, &filters)
        .await?;

    let entries: Vec<serde_json::Value> = entries
        .iter()
        .map(|entry| {
            json!({
                "id": entry.id,
                "outboxId": entry.outbox_id,
                "eventType": entry.event_type,
                "targetId": entry.target_id,
                "targetType": entry.target_type,
                "status": entry.status,
                "attemptNumber": entry.attempt_number,
                "errorSnippet": entry.error_snippet,
                "createdAt": entry.created_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            })
        })
        .collect();

    Ok(json_response(
        StatusCode::OK,
        &json!({ "entries": entries }),
    ))
}
