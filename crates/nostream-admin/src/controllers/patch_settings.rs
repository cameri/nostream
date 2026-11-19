//! `PATCH <prefix>/admin/settings`: validate each path, merge the changes into the user
//! document, validate the merged result, write it with a backup, audit it, and enqueue the
//! `settings.changed` row. Mirrors `src/controllers/admin/patch-settings-controller.ts`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_json_body_middleware::{
    JsonBody, SettingsChange, SettingsPatch, invalid_request, settings_patch, validation_failed,
};
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::request_context::{ClientInfo, RequestDocument};
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, json_response};
use crate::state::AdminState;

/// `getSettingsReloadBehavior`: `restart-required` for `workers.`, `payments` and `network.`,
/// else `hot-reload` (Value 15 — `payments` is compared without a dot, as written).
pub fn reload_behavior(path: &str) -> &'static str {
    if path.starts_with("workers.") || path.starts_with("payments") || path.starts_with("network.")
    {
        "restart-required"
    } else {
        "hot-reload"
    }
}

fn redacted_change(change: &SettingsChange) -> Value {
    let value = serde_yaml::from_str::<serde_yaml::Value>(&change.value.to_string())
        .unwrap_or(serde_yaml::Value::Null);
    let redacted = nostream_config::redaction::redact_settings_value(&change.path, &value);
    serde_json::to_value(redacted).unwrap_or(Value::Null)
}

/// Applies the patch to the user document and the merged document together, the way the
/// capture does, so validation sees what the next read will.
fn apply_changes(
    user: &serde_yaml::Value,
    merged: &serde_yaml::Value,
    changes: &[SettingsChange],
) -> Result<(serde_yaml::Value, serde_yaml::Value), String> {
    let mut next_user = user.clone();
    for change in changes {
        let value = serde_yaml::from_str::<serde_yaml::Value>(&change.value.to_string())
            .map_err(|error| format!("{}: {error}", change.path))?;
        // `null` is a value, not an absent one: the capture's schema is
        // `z.custom(v => v !== undefined)` (`admin-settings-schema.ts:6`), so it reaches the
        // validator and answers `400 Validation failed … Expected string, got null`.
        next_user = nostream_config::path::set_by_path(&next_user, &change.path, value)
            .map_err(|error| format!("{}: {error}", change.path))?;
    }

    let mut next_merged = merged.clone();
    for change in changes {
        let value = nostream_config::path::get_by_path(&next_user, &change.path)
            .map_err(|error| format!("{}: {error}", change.path))?
            .cloned()
            .unwrap_or(serde_yaml::Value::Null);
        next_merged = nostream_config::path::set_by_path(&next_merged, &change.path, value)
            .map_err(|error| format!("{}: {error}", change.path))?;
    }

    Ok((next_user, next_merged))
}

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    client: ClientInfo,
    RequestDocument { merged, defaults }: RequestDocument,
    JsonBody(body): JsonBody,
) -> HandlerResult {
    let Some(SettingsPatch { changes, list_form }) = settings_patch(&body) else {
        return Ok(invalid_request());
    };

    // The path guards, before anything is written: a write-protected path first, then the
    // schema check (Value 14).
    let mut issues = Vec::new();
    for change in &changes {
        if nostream_config::redaction::is_write_protected_settings_path(&change.path) {
            issues.push(nostream_config::Issue::new(
                change.path.clone(),
                "Path is write-protected",
            ));
            continue;
        }
        match nostream_config::path::validate_path_against_defaults(&defaults, &change.path) {
            Ok(found) => issues.extend(found),
            Err(error) => issues.push(nostream_config::Issue::new(
                change.path.clone(),
                error.to_string(),
            )),
        }
    }
    if !issues.is_empty() {
        return Ok(validation_failed(&issues));
    }

    let user = state.user_document()?;
    let Ok((next_user, next_merged)) = apply_changes(&user, &merged, &changes) else {
        return Ok(invalid_request());
    };

    let validation = nostream_config::validate_document(&next_merged, &defaults);
    if !validation.is_empty() {
        return Ok(validation_failed(&validation));
    }

    state.save_user_settings(&next_user)?;

    let updated: Vec<Value> = changes
        .iter()
        .map(|change| {
            json!({
                "path": change.path,
                "value": redacted_change(change),
                "reload": reload_behavior(&change.path),
            })
        })
        .collect();

    let audit_changes: Vec<Value> = updated
        .iter()
        .map(|change| json!({ "path": change["path"], "reload": change["reload"] }))
        .collect();
    let _ = state.append_settings_audit(json!({
        "timestamp": crate::state::iso8601(state.clock().now_ms()),
        "action": "settings.updated",
        "changes": audit_changes,
        "remoteAddress": client.address,
    }));
    crate::controllers::post_login::record_audit(&state, "settings.updated", &client.address);
    state
        .enqueue_settings_changed(json!({
            "changes": updated,
            "remoteAddress": client.address,
        }))
        .await;

    match updated.as_slice() {
        [only] if !list_form => Ok(json_response(
            StatusCode::OK,
            &json!({
                "ok": true,
                "path": only["path"],
                "value": only["value"],
                "reload": only["reload"],
            }),
        )),
        _ => Ok(json_response(
            StatusCode::OK,
            &json!({ "ok": true, "changes": updated }),
        )),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn the_reload_class_is_the_capture_s() {
        assert_eq!(reload_behavior("workers.count"), "restart-required");
        assert_eq!(reload_behavior("payments"), "restart-required");
        assert_eq!(reload_behavior("payments.enabled"), "restart-required");
        assert_eq!(
            reload_behavior("network.maxPayloadSize"),
            "restart-required"
        );
        assert_eq!(reload_behavior("wot.enabled"), "hot-reload");
        assert_eq!(reload_behavior("info.name"), "hot-reload");
    }

    #[test]
    fn a_change_lands_in_both_documents() {
        let user: serde_yaml::Value = serde_yaml::from_str("info:\n  name: Old\n").unwrap();
        let merged: serde_yaml::Value =
            serde_yaml::from_str("info:\n  name: Old\n  description: shipped\n").unwrap();
        let changes = vec![SettingsChange {
            path: "info.name".to_owned(),
            value: json!("New"),
        }];
        let (next_user, next_merged) = apply_changes(&user, &merged, &changes).unwrap();
        assert_eq!(
            next_user["info"]["name"],
            serde_yaml::Value::String("New".to_owned())
        );
        assert_eq!(
            next_merged["info"]["name"],
            serde_yaml::Value::String("New".to_owned())
        );
        assert_eq!(
            next_merged["info"]["description"],
            serde_yaml::Value::String("shipped".to_owned())
        );
    }
}
