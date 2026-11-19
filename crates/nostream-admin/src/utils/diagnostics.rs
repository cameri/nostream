//! The diagnostics export payload. Mirrors `src/utils/admin-diagnostics-export.ts`.
//!
//! `version` is `CARGO_PKG_VERSION` where the capture reads `package.json` (Assumption 11): the
//! Rust deployment has no `package.json`, and the console displays the string as text.

use nostream_config::notifications::{
    AdminNotificationsSettings, get_merged_admin_notifications, get_redacted_admin_notifications,
};
use nostream_config::redaction::redact_settings_secrets;
use serde_json::{Value, json};

use crate::error::AdminError;
use crate::state::{AdminState, iso8601};
use crate::utils::health;

/// Builds `GET /diagnostics/export`'s payload.
pub async fn build(state: &AdminState) -> Result<Value, AdminError> {
    let settings = state.settings()?;
    let (merged, _) = state.merged_document()?;

    let health = health::collect(state).await;
    let settings_document = serde_json::to_value(redact_settings_secrets(&merged))
        .map_err(|error| AdminError::Internal(format!("settings to JSON: {error}")))?;

    let configured: Option<AdminNotificationsSettings> = settings
        .admin
        .as_ref()
        .and_then(|admin| admin.notifications.clone());
    let notifications = get_merged_admin_notifications(configured.as_ref(), None);
    let redacted =
        get_redacted_admin_notifications(&notifications, None).map_err(AdminError::Config)?;

    Ok(json!({
        "generatedAt": iso8601(state.clock().now_ms()),
        "version": env!("CARGO_PKG_VERSION"),
        "health": health,
        "settings": settings_document,
        "notifications": redacted,
        "networkHealth": { "latest": state.latest_probe_snapshot() },
        "operations": { "workers": state.heartbeats() },
    }))
}
