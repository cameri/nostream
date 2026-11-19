//! The JSON body middleware. Mirrors
//! `src/handlers/request-handlers/admin-json-body-middleware.ts` and the three admin body
//! schemas (`src/schemas/admin-*.ts`).
//!
//! `application/json` is required on the routes that mount it (a `text/plain` body is
//! `415 {"error":"Unsupported Media Type"}`), the body cap is 1 mb, and the schemas are the
//! capture's zod objects: strict on their keys, and a `null` value is allowed where `undefined`
//! is not.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::http::{StatusCode, header};
use axum::response::Response;
use serde_json::{Map, Value, json};

use crate::controllers::with_admin_controller_request_handler::{error_message, json_response};
use crate::state::AdminState;

/// The body cap the capture mounts (`json({ limit: '1mb' })`).
pub const JSON_BODY_LIMIT: usize = 1024 * 1024;

/// `415 {"error":"Unsupported Media Type"}`.
pub fn unsupported_media_type() -> Response {
    error_message(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Unsupported Media Type")
}

/// `400 {"error":"Invalid request"}`.
pub fn invalid_request() -> Response {
    json_response(StatusCode::BAD_REQUEST, &invalid_request_body())
}

/// The body [`invalid_request`] answers, for a caller that has no response to build.
pub fn invalid_request_body() -> Value {
    json!({ "error": "Invalid request" })
}

fn payload_too_large() -> Response {
    error_message(StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large")
}

fn is_json_content_type(request: &Request) -> bool {
    request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .map(|media_type| media_type.trim().eq_ignore_ascii_case("application/json"))
                .unwrap_or(false)
        })
}

async fn read_body(request: Request) -> Result<Bytes, Response> {
    axum::body::to_bytes(request.into_body(), JSON_BODY_LIMIT)
        .await
        .map_err(|_| payload_too_large())
}

/// A body that parsed as a JSON object, with the capture's 415/413 rules.
pub struct JsonBody(pub Map<String, Value>);

impl FromRequest<Arc<AdminState>> for JsonBody {
    type Rejection = Response;

    async fn from_request(
        request: Request,
        _state: &Arc<AdminState>,
    ) -> Result<Self, Self::Rejection> {
        if !is_json_content_type(&request) {
            return Err(unsupported_media_type());
        }
        let bytes = read_body(request).await?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid_request())?;
        match value {
            Value::Object(object) => Ok(Self(object)),
            _ => Err(invalid_request()),
        }
    }
}

/// The login body: parsed as JSON when the content type is JSON, an empty object otherwise, so
/// a `text/plain` login body reaches the schema and answers `400`, never `415` (R4).
pub struct LoginBody(pub Map<String, Value>);

impl FromRequest<Arc<AdminState>> for LoginBody {
    type Rejection = Response;

    async fn from_request(
        request: Request,
        _state: &Arc<AdminState>,
    ) -> Result<Self, Self::Rejection> {
        if !is_json_content_type(&request) {
            return Ok(Self(Map::new()));
        }
        let bytes = read_body(request).await?;
        if bytes.is_empty() {
            return Ok(Self(Map::new()));
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(object)) => Ok(Self(object)),
            _ => Ok(Self(Map::new())),
        }
    }
}

/// `{password: string(min 1)}`, strict (`adminLoginBodySchema`).
pub fn login_password(body: &Map<String, Value>) -> Option<String> {
    if body.keys().any(|key| key != "password") {
        return None;
    }
    match body.get("password") {
        Some(Value::String(password)) if !password.is_empty() => Some(password.clone()),
        _ => None,
    }
}

/// One settings change (`adminSettingsChangeSchema`).
#[derive(Debug, Clone, PartialEq)]
pub struct SettingsChange {
    pub path: String,
    pub value: Value,
}

fn parse_change(value: &Value) -> Option<SettingsChange> {
    let Value::Object(object) = value else {
        return None;
    };
    if object.len() != 2 || !object.contains_key("path") || !object.contains_key("value") {
        return None;
    }
    let Some(Value::String(path)) = object.get("path") else {
        return None;
    };
    if path.is_empty() {
        return None;
    }
    Some(SettingsChange {
        path: path.clone(),
        value: object.get("value")?.clone(),
    })
}

/// The settings patch: either `{path,value}` or `{changes:[…]}` with at least one
/// (`adminSettingsPatchBodySchema`).
#[derive(Debug, Clone, PartialEq)]
pub struct SettingsPatch {
    /// The changes, in order.
    pub changes: Vec<SettingsChange>,
    /// Whether the body used the list form — which decides the response shape (R5 row 15).
    pub list_form: bool,
}

/// Parses the settings patch body, answering `None` for anything the schema refuses.
pub fn settings_patch(body: &Map<String, Value>) -> Option<SettingsPatch> {
    if body.len() == 1
        && let Some(Value::Array(changes)) = body.get("changes")
    {
        if changes.is_empty() {
            return None;
        }
        let parsed: Option<Vec<SettingsChange>> = changes.iter().map(parse_change).collect();
        return Some(SettingsPatch {
            changes: parsed?,
            list_form: true,
        });
    }

    let change = parse_change(&Value::Object(body.clone()))?;
    Some(SettingsPatch {
        changes: vec![change],
        list_form: false,
    })
}

/// `{filename: string(min 1)}`, strict (`adminSettingsRestoreBodySchema`).
pub fn restore_filename(body: &Map<String, Value>) -> Option<String> {
    if body.keys().any(|key| key != "filename") {
        return None;
    }
    match body.get("filename") {
        Some(Value::String(filename)) if !filename.is_empty() => Some(filename.clone()),
        _ => None,
    }
}

/// `{targetId: string(min 1)}`, strict (`post-notification-test-controller.ts:8-12`).
pub fn notification_target_id(body: &Map<String, Value>) -> Option<String> {
    if body.keys().any(|key| key != "targetId") {
        return None;
    }
    match body.get("targetId") {
        Some(Value::String(target_id)) if !target_id.is_empty() => Some(target_id.clone()),
        _ => None,
    }
}

/// The notification patch body (`adminNotificationsPatchBodySchema`): the keys the schema
/// carries, each with the type it must have.
pub fn notification_patch(body: &Map<String, Value>) -> Option<Value> {
    const KEYS: [&str; 5] = [
        "enabled",
        "targets",
        "events",
        "retry",
        "deliveryLogRetentionDays",
    ];
    if body.keys().any(|key| !KEYS.contains(&key.as_str())) {
        return None;
    }
    if let Some(enabled) = body.get("enabled")
        && !enabled.is_boolean()
    {
        return None;
    }
    if let Some(targets) = body.get("targets") {
        let Value::Array(targets) = targets else {
            return None;
        };
        for target in targets {
            let Value::Object(target) = target else {
                return None;
            };
            const TARGET_KEYS: [&str; 7] = [
                "id", "type", "enabled", "url", "secret", "botToken", "chatId",
            ];
            if target
                .keys()
                .any(|key| !TARGET_KEYS.contains(&key.as_str()))
            {
                return None;
            }
            let id_valid = matches!(target.get("id"), Some(Value::String(id)) if !id.is_empty());
            let type_valid = matches!(
                target.get("type"),
                Some(Value::String(channel))
                    if ["http", "discord", "slack", "telegram"].contains(&channel.as_str())
            );
            let enabled_valid = target.get("enabled").is_some_and(Value::is_boolean);
            if !id_valid || !type_valid || !enabled_valid {
                return None;
            }
            for key in ["url", "secret", "botToken", "chatId"] {
                if let Some(value) = target.get(key)
                    && !value.is_string()
                {
                    return None;
                }
            }
        }
    }
    if let Some(events) = body.get("events") {
        let Value::Object(events) = events else {
            return None;
        };
        const EVENT_KEYS: [&str; 8] = [
            "admission.invoice.created",
            "admission.invoice.paid",
            "admission.invoice.failed",
            "settings.changed",
            "relay.restarted",
            "probe.failed",
            "probe.recovered",
            "ssl.expiring",
        ];
        if events
            .iter()
            .any(|(key, value)| !EVENT_KEYS.contains(&key.as_str()) || !value.is_boolean())
        {
            return None;
        }
    }
    if let Some(retry) = body.get("retry") {
        let Value::Object(retry) = retry else {
            return None;
        };
        if retry.iter().any(|(key, value)| {
            !["maxAttempts", "baseDelayMs"].contains(&key.as_str()) || !value.is_number()
        }) {
            return None;
        }
        if let Some(max_attempts) = retry.get("maxAttempts")
            && max_attempts.as_u64().is_none_or(|attempts| attempts < 1)
        {
            return None;
        }
    }
    if let Some(retention) = body.get("deliveryLogRetentionDays")
        && retention.as_u64().is_none_or(|days| days < 1)
    {
        return None;
    }
    Some(Value::Object(body.clone()))
}

/// The moderation action body (`adminModerationActionSchema`): `action` is one of six, and
/// `pubkey`/`ip` are optional strings.
pub fn moderation_action(
    body: &Map<String, Value>,
) -> Option<(String, Option<String>, Option<String>)> {
    if body
        .keys()
        .any(|key| !["action", "pubkey", "ip"].contains(&key.as_str()))
    {
        return None;
    }
    let Some(Value::String(action)) = body.get("action") else {
        return None;
    };
    if ![
        "ban-pubkey",
        "unban-pubkey",
        "whitelist-pubkey",
        "unwhitelist-pubkey",
        "whitelist-ip",
        "unwhitelist-ip",
    ]
    .contains(&action.as_str())
    {
        return None;
    }
    let pubkey = match body.get("pubkey") {
        Some(Value::String(pubkey)) => Some(pubkey.clone()),
        Some(_) => return None,
        None => None,
    };
    let ip = match body.get("ip") {
        Some(Value::String(ip)) => Some(ip.clone()),
        Some(_) => return None,
        None => None,
    };
    Some((action.clone(), pubkey, ip))
}

/// The moderation limits patch body (`adminModerationLimitsPatchSchema`): each list is
/// present-or-absent, so a patch can clear a list as well as replace it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModerationLimitsPatch {
    pub pubkey_blacklist: Option<Vec<String>>,
    pub pubkey_whitelist: Option<Vec<String>>,
    pub kind_blacklist: Option<Vec<Value>>,
    pub kind_whitelist: Option<Vec<Value>>,
    pub bypass_pubkeys: Option<Vec<String>>,
    pub bypass_ip_addresses: Option<Vec<String>>,
}

/// Parses the limits patch, answering `None` for anything the schema refuses.
pub fn moderation_limits_patch(body: &Map<String, Value>) -> Option<ModerationLimitsPatch> {
    if body
        .keys()
        .any(|key| !["pubkey", "kind", "rateLimitBypass"].contains(&key.as_str()))
    {
        return None;
    }

    let mut patch = ModerationLimitsPatch::default();

    if let Some(pubkey) = body.get("pubkey") {
        let Value::Object(pubkey) = pubkey else {
            return None;
        };
        if pubkey
            .keys()
            .any(|key| !["blacklist", "whitelist"].contains(&key.as_str()))
        {
            return None;
        }
        if let Some(blacklist) = pubkey.get("blacklist") {
            patch.pubkey_blacklist = Some(string_list(blacklist)?);
        }
        if let Some(whitelist) = pubkey.get("whitelist") {
            patch.pubkey_whitelist = Some(string_list(whitelist)?);
        }
    }

    if let Some(kind) = body.get("kind") {
        let Value::Object(kind) = kind else {
            return None;
        };
        if kind
            .keys()
            .any(|key| !["blacklist", "whitelist"].contains(&key.as_str()))
        {
            return None;
        }
        if let Some(blacklist) = kind.get("blacklist") {
            patch.kind_blacklist = Some(kind_rule_list(blacklist)?);
        }
        if let Some(whitelist) = kind.get("whitelist") {
            patch.kind_whitelist = Some(kind_rule_list(whitelist)?);
        }
    }

    if let Some(bypass) = body.get("rateLimitBypass") {
        let Value::Object(bypass) = bypass else {
            return None;
        };
        if bypass
            .keys()
            .any(|key| !["pubkeys", "ipAddresses"].contains(&key.as_str()))
        {
            return None;
        }
        if let Some(pubkeys) = bypass.get("pubkeys") {
            patch.bypass_pubkeys = Some(string_list(pubkeys)?);
        }
        if let Some(ips) = bypass.get("ipAddresses") {
            patch.bypass_ip_addresses = Some(string_list(ips)?);
        }
    }

    Some(patch)
}

fn string_list(value: &Value) -> Option<Vec<String>> {
    let Value::Array(items) = value else {
        return None;
    };
    items
        .iter()
        .map(|item| match item {
            Value::String(text) => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn kind_rule_list(value: &Value) -> Option<Vec<Value>> {
    let Value::Array(items) = value else {
        return None;
    };
    for item in items {
        let valid = match item {
            Value::Number(number) => number.as_u64().is_some_and(|kind| kind <= 65_535),
            Value::Array(range) => {
                range.len() == 2
                    && range
                        .iter()
                        .all(|bound| bound.as_u64().is_some_and(|kind| kind <= 65_535))
                    && range[0].as_u64() <= range[1].as_u64()
            }
            _ => false,
        };
        if !valid {
            return None;
        }
    }
    Some(items.clone())
}

/// `400 {"error":"Validation failed","issues":[…]}`, the settings and notifications patch
/// failure body.
pub fn validation_failed(issues: &[nostream_config::Issue]) -> Response {
    json_response(StatusCode::BAD_REQUEST, &validation_failed_body(issues))
}

/// The body [`validation_failed`] answers, for a caller that has no response to build.
pub fn validation_failed_body(issues: &[nostream_config::Issue]) -> Value {
    let issues: Vec<Value> = issues
        .iter()
        .map(|issue| json!({ "path": issue.path, "message": issue.message }))
        .collect();
    json!({ "error": "Validation failed", "issues": issues })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(object) => object,
            _ => panic!("not an object"),
        }
    }

    #[test]
    fn the_login_body_is_strict_and_needs_a_password() {
        assert_eq!(
            login_password(&object(json!({"password": "x"}))),
            Some("x".to_owned())
        );
        assert_eq!(login_password(&object(json!({"password": ""}))), None);
        assert_eq!(
            login_password(&object(json!({"password": "x", "extra": 1}))),
            None
        );
        assert_eq!(login_password(&object(json!({}))), None);
    }

    #[test]
    fn the_settings_patch_takes_one_change_or_a_list() {
        let single =
            settings_patch(&object(json!({"path": "wot.enabled", "value": false}))).unwrap();
        assert!(!single.list_form);
        assert_eq!(single.changes.len(), 1);
        assert_eq!(single.changes[0].value, Value::Bool(false));

        let listed = settings_patch(&object(
            json!({"changes": [{"path": "wot.enabled", "value": null}]}),
        ))
        .unwrap();
        assert!(listed.list_form);
        assert_eq!(listed.changes[0].value, Value::Null);

        assert!(settings_patch(&object(json!({"changes": []}))).is_none());
        assert!(settings_patch(&object(json!({"path": "wot.enabled"}))).is_none());
        assert!(settings_patch(&object(json!({"path": "", "value": 1}))).is_none());
        assert!(settings_patch(&object(json!({"path": "a", "value": 1, "extra": 2}))).is_none());
    }

    #[test]
    fn a_notification_patch_is_strict_about_its_keys() {
        assert!(notification_patch(&object(json!({"enabled": true}))).is_some());
        assert!(notification_patch(&object(json!({"enabled": "yes"}))).is_none());
        assert!(notification_patch(&object(json!({"unknown": true}))).is_none());
        assert!(
            notification_patch(&object(
                json!({"targets": [{"id": "a", "type": "http", "enabled": true}]})
            ))
            .is_some()
        );
        assert!(
            notification_patch(&object(json!({"targets": [{"id": "a", "type": "mail"}]})))
                .is_none()
        );
        assert!(
            notification_patch(&object(
                json!({"targets": [{"id": "", "type": "http", "enabled": true}]})
            ))
            .is_none()
        );
    }

    #[test]
    fn a_moderation_action_needs_one_of_the_six() {
        assert!(
            moderation_action(&object(json!({"action": "ban-pubkey", "pubkey": "ab"}))).is_some()
        );
        assert!(moderation_action(&object(json!({"action": "nuke"}))).is_none());
        assert!(moderation_action(&object(json!({"action": "ban-pubkey", "extra": 1}))).is_none());
        assert!(moderation_action(&object(json!({"action": "ban-pubkey", "pubkey": 7}))).is_none());
    }
}
