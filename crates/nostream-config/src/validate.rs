//! The settings validator. Mirrors `src/utils/settings-config.ts` `validateSettings` and
//! `validateShape` at the capture commit, including issue order and message text.
//!
//! Order is part of the contract: the semantic rules run first, then the defaults document is
//! walked as a schema, then the admin-notification rules. Two behaviours are load-bearing:
//! unknown keys are rejected at every depth, and the shipped defaults are the schema, so the
//! defaults file is part of the contract rather than just data.

use nostream_core::EventStoreBackend;
use serde_yaml::Value;

use crate::error::ConfigError;
use crate::issue::Issue;
use crate::path::{PathToken, format_path_tokens};
use crate::settings::Settings;
use crate::value::{
    compare_le, is_nil, is_plain_object, js_typeof, key, key_path, merge_deep_right, number_ge,
    number_le, number_lt, to_number, truthy_opt,
};

/// Validates a settings document against a defaults document.
///
/// `candidate` is the merged settings (defaults deep-merged with the user's overrides);
/// `defaults` is the shipped defaults document, used as the schema.
pub fn validate_document(candidate: &Value, defaults: &Value) -> Vec<Issue> {
    let mut issues = Vec::new();

    if !truthy_opt(key_path(candidate, &["info", "relay_url"])) {
        issues.push(Issue::new("info.relay_url", "relay_url is required"));
    }

    if !truthy_opt(key_path(candidate, &["info", "name"])) {
        issues.push(Issue::new("info.name", "name is required"));
    }

    if !truthy_opt(key(candidate, "network")) {
        issues.push(Issue::new("network", "network section is required"));
    }

    if truthy_opt(key_path(candidate, &["payments", "enabled"]))
        && !truthy_opt(key_path(candidate, &["payments", "processor"]))
    {
        issues.push(Issue::new(
            "payments.processor",
            "processor is required when payments are enabled",
        ));
    }

    let strategy = key_path(candidate, &["limits", "rateLimiter", "strategy"]);
    if truthy_opt(strategy) && !matches!(strategy, Some(Value::String(name)) if name == "ewma" || name == "sliding_window")
    {
        issues.push(Issue::new(
            "limits.rateLimiter.strategy",
            "strategy must be ewma or sliding_window",
        ));
    }

    let backend = key_path(candidate, &["eventStore", "backend"]);
    if !is_nil(backend) && !is_event_store_backend(backend) {
        let names = EventStoreBackend::ALL
            .iter()
            .map(|backend| backend.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        issues.push(Issue::new(
            "eventStore.backend",
            format!("backend must be one of: {names}"),
        ));
    }

    if let Some(pow) = key_path(candidate, &["limits", "event", "pow"])
        && truthy_opt(key(pow, "enabled"))
    {
        let floor_bits = key(pow, "floorBits");
        let ceiling_bits = key(pow, "ceilingBits");

        if !number_ge(floor_bits, 0.0) || !compare_le(floor_bits, ceiling_bits) {
            issues.push(Issue::new(
                "limits.event.pow.floorBits",
                "floorBits must be >= 0 and <= ceilingBits",
            ));
        }
        if !number_le(ceiling_bits, 256.0) {
            issues.push(Issue::new(
                "limits.event.pow.ceilingBits",
                "ceilingBits must be <= 256",
            ));
        }
        if !to_number_is_positive(key(pow, "periodMs")) {
            issues.push(Issue::new(
                "limits.event.pow.periodMs",
                "periodMs must be greater than 0",
            ));
        }
        if !to_number_is_positive(key(pow, "targetEventsPerSecond")) {
            issues.push(Issue::new(
                "limits.event.pow.targetEventsPerSecond",
                "targetEventsPerSecond must be greater than 0",
            ));
        }

        if let Some(Value::Sequence(thresholds)) = key(pow, "wotThresholds") {
            for (index, threshold) in thresholds.iter().enumerate() {
                if !matches!(threshold, Value::Mapping(_)) {
                    issues.push(Issue::new(
                        format!("limits.event.pow.wotThresholds[{index}]"),
                        "wotThresholds entry must be an object",
                    ));
                    continue;
                }
                if !number_ge(key(threshold, "maxDistance"), 0.0) {
                    issues.push(Issue::new(
                        format!("limits.event.pow.wotThresholds[{index}].maxDistance"),
                        "maxDistance must be >= 0",
                    ));
                }
                let factor = key(threshold, "difficultyFactor");
                if !number_ge(factor, 0.0) || !number_le(factor, 1.0) {
                    issues.push(Issue::new(
                        format!("limits.event.pow.wotThresholds[{index}].difficultyFactor"),
                        "difficultyFactor must be between 0 and 1",
                    ));
                }
            }
        }
    }

    if let Some(limits) = key(candidate, "limits") {
        validate_rate_limit_periods(key_path(limits, &["event", "rateLimits"]), "limits.event.rateLimits", &mut issues);
        validate_rate_limit_periods(key_path(limits, &["message", "rateLimits"]), "limits.message.rateLimits", &mut issues);
        validate_rate_limit_periods(key_path(limits, &["connection", "rateLimits"]), "limits.connection.rateLimits", &mut issues);
        validate_rate_limit_periods(key_path(limits, &["invoice", "rateLimits"]), "limits.invoice.rateLimits", &mut issues);
        validate_rate_limit_periods(
            key_path(limits, &["admissionCheck", "rateLimits"]),
            "limits.admissionCheck.rateLimits",
            &mut issues,
        );
        validate_rate_limit_periods(key_path(limits, &["invite", "rateLimits"]), "limits.invite.rateLimits", &mut issues);
        validate_rate_limit_periods(key_path(limits, &["admin", "rateLimits"]), "limits.admin.rateLimits", &mut issues);
        validate_rate_limit_periods(
            key_path(limits, &["admin", "loginRateLimits"]),
            "limits.admin.loginRateLimits",
            &mut issues,
        );
    }

    validate_shape(defaults, Some(candidate), &mut Vec::new(), &mut issues);
    issues.extend(validate_admin_notifications(candidate));

    issues
}

fn to_number_is_positive(value: Option<&Value>) -> bool {
    value.and_then(to_number).is_some_and(|number| number > 0.0)
}

fn is_event_store_backend(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(name)) if EventStoreBackend::parse(name).is_some())
}

fn validate_rate_limit_periods(rate_limits: Option<&Value>, path_prefix: &str, issues: &mut Vec<Issue>) {
    let Some(Value::Sequence(entries)) = rate_limits else {
        return;
    };
    for (index, entry) in entries.iter().enumerate() {
        if !is_plain_object(entry) {
            issues.push(Issue::new(
                format!("{path_prefix}[{index}]"),
                "rateLimits entry must be an object",
            ));
            continue;
        }
        if !to_number_is_positive(key(entry, "period")) {
            issues.push(Issue::new(
                format!("{path_prefix}[{index}].period"),
                "period must be greater than 0",
            ));
        }
    }
}

/// Walks the defaults document as the schema for the candidate.
fn validate_shape(
    schema: &Value,
    candidate: Option<&Value>,
    path: &mut Vec<PathToken>,
    issues: &mut Vec<Issue>,
) {
    let Some(candidate) = candidate else {
        return;
    };

    let rendered = {
        let rendered = format_path_tokens(path);
        if rendered.is_empty() {
            "$".to_owned()
        } else {
            rendered
        }
    };

    match schema {
        Value::Sequence(schema_entries) => {
            let Value::Sequence(candidates) = candidate else {
                issues.push(Issue::new(
                    rendered,
                    format!("Expected array, got {}", js_typeof(candidate)),
                ));
                return;
            };

            if schema_entries.is_empty() {
                return;
            }

            for (index, entry) in candidates.iter().enumerate() {
                let matches_any = schema_entries.iter().any(|schema_entry| {
                    let mut local_issues = Vec::new();
                    let mut local_path = path.clone();
                    local_path.push(PathToken::Index(index));
                    validate_shape(schema_entry, Some(entry), &mut local_path, &mut local_issues);
                    local_issues.is_empty()
                });

                if !matches_any {
                    let mut issue_path = path.clone();
                    issue_path.push(PathToken::Index(index));
                    issues.push(Issue::new(
                        format_path_tokens(&issue_path),
                        "Array element does not match expected schema shape",
                    ));
                }
            }
        }
        Value::Mapping(schema_mapping) => {
            let Value::Mapping(candidates) = candidate else {
                issues.push(Issue::new(
                    rendered,
                    format!("Expected object, got {}", js_typeof(candidate)),
                ));
                return;
            };

            for key in candidates.keys() {
                let Some(key) = key.as_str() else {
                    continue;
                };
                if rendered == "admin" && key == "passwordHash" {
                    continue;
                }
                if !schema_mapping.contains_key(key) {
                    let mut issue_path = path.clone();
                    issue_path.push(PathToken::Key(key.to_owned()));
                    issues.push(Issue::new(format_path_tokens(&issue_path), "Unknown setting key"));
                }
            }

            for (key, schema_value) in schema_mapping {
                let Some(key) = key.as_str() else {
                    continue;
                };
                let mut child_path = path.clone();
                child_path.push(PathToken::Key(key.to_owned()));
                validate_shape(schema_value, candidates.get(key), &mut child_path, issues);
            }
        }
        _ => {
            if matches!(candidate, Value::Null) && !matches!(schema, Value::Null) {
                issues.push(Issue::new(
                    rendered,
                    format!("Expected {}, got null", js_typeof(schema)),
                ));
                return;
            }
            if !matches!(schema, Value::Null) && js_typeof(schema) != js_typeof(candidate) {
                issues.push(Issue::new(
                    rendered,
                    format!("Expected {}, got {}", js_typeof(schema), js_typeof(candidate)),
                ));
            }
        }
    }
}

fn validate_admin_notifications(candidate: &Value) -> Vec<Issue> {
    let mut issues = Vec::new();
    let Some(notifications) = key_path(candidate, &["admin", "notifications"]) else {
        return issues;
    };

    let retry = key(notifications, "retry");
    if let Some(max_attempts) = retry.and_then(|retry| key(retry, "maxAttempts"))
        && number_lt(Some(max_attempts), 1.0)
    {
        issues.push(Issue::new(
            "admin.notifications.retry.maxAttempts",
            "maxAttempts must be at least 1",
        ));
    }
    if let Some(base_delay) = retry.and_then(|retry| key(retry, "baseDelayMs"))
        && number_lt(Some(base_delay), 0.0)
    {
        issues.push(Issue::new(
            "admin.notifications.retry.baseDelayMs",
            "baseDelayMs must be >= 0",
        ));
    }
    if let Some(retention) = key(notifications, "deliveryLogRetentionDays")
        && number_lt(Some(retention), 1.0)
    {
        issues.push(Issue::new(
            "admin.notifications.deliveryLogRetentionDays",
            "deliveryLogRetentionDays must be at least 1",
        ));
    }

    let raw_targets = key(notifications, "targets");
    if let Some(targets) = raw_targets
        && !matches!(targets, Value::Sequence(_))
    {
        issues.push(Issue::new(
            "admin.notifications.targets",
            "targets must be an array",
        ));
        return issues;
    }

    let targets: &[Value] = match raw_targets {
        Some(Value::Sequence(entries)) => entries.as_slice(),
        _ => &[],
    };

    let mut target_ids: Vec<String> = Vec::new();
    for (index, target) in targets.iter().enumerate() {
        let prefix = format!("admin.notifications.targets[{index}]");
        if !matches!(target, Value::Mapping(_)) {
            issues.push(Issue::new(prefix, "target must be an object"));
            continue;
        }

        match key(target, "id") {
            Some(Value::String(id)) if !id.trim().is_empty() => {
                if target_ids.iter().any(|existing| existing == id) {
                    issues.push(Issue::new(format!("{prefix}.id"), "target id must be unique"));
                } else {
                    target_ids.push(id.clone());
                }
            }
            _ => issues.push(Issue::new(format!("{prefix}.id"), "target id is required")),
        }

        let target_type = match key(target, "type") {
            Some(Value::String(name))
                if matches!(name.as_str(), "http" | "discord" | "slack" | "telegram") =>
            {
                Some(name.as_str())
            }
            _ => {
                issues.push(Issue::new(
                    format!("{prefix}.type"),
                    "type must be http, discord, slack, or telegram",
                ));
                None
            }
        };

        if let Some(enabled) = key(target, "enabled")
            && !matches!(enabled, Value::Bool(_))
        {
            issues.push(Issue::new(format!("{prefix}.enabled"), "enabled must be a boolean"));
        }

        match target_type {
            Some("telegram") => {
                if !is_non_blank_string(key(target, "botToken")) {
                    issues.push(Issue::new(
                        format!("{prefix}.botToken"),
                        "botToken is required for telegram targets",
                    ));
                }
                if !is_non_blank_string(key(target, "chatId")) {
                    issues.push(Issue::new(
                        format!("{prefix}.chatId"),
                        "chatId is required for telegram targets",
                    ));
                }
            }
            Some(_) => match key(target, "url") {
                Some(Value::String(url)) if !url.trim().is_empty() => {
                    match check_webhook_url(url) {
                        UrlCheck::Ok => {}
                        UrlCheck::BadProtocol => issues.push(Issue::new(
                            format!("{prefix}.url"),
                            "url must use http or https",
                        )),
                        UrlCheck::Invalid => {
                            issues.push(Issue::new(format!("{prefix}.url"), "url must be a valid URL"))
                        }
                    }
                }
                _ => issues.push(Issue::new(
                    format!("{prefix}.url"),
                    "url is required for webhook targets",
                )),
            },
            None => {}
        }
    }

    issues
}

fn is_non_blank_string(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(text)) if !text.trim().is_empty())
}

enum UrlCheck {
    Ok,
    BadProtocol,
    Invalid,
}

fn check_webhook_url(raw: &str) -> UrlCheck {
    let trimmed = raw.trim();
    let Some(colon) = trimmed.find(':') else {
        return UrlCheck::Invalid;
    };
    let scheme = &trimmed[..colon];
    let mut characters = scheme.chars();
    let valid_scheme = matches!(characters.next(), Some(first) if first.is_ascii_alphabetic())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        });
    if !valid_scheme {
        return UrlCheck::Invalid;
    }

    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return UrlCheck::BadProtocol;
    }

    let Some(authority) = trimmed[colon + 1..].strip_prefix("//") else {
        return UrlCheck::Invalid;
    };
    let host = authority
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if host.is_empty() {
        return UrlCheck::Invalid;
    }

    UrlCheck::Ok
}

/// Validates the typed settings by serializing them back to a document, so there is exactly
/// one validation algorithm.
pub fn validate(settings: &Settings, defaults: &Value) -> Result<Vec<Issue>, ConfigError> {
    let candidate = serde_yaml::to_value(settings)?;
    Ok(validate_document(&candidate, defaults))
}

/// Deep-merges a user document over the defaults (the loader's step before validation).
pub fn merge_document(defaults: &Value, user: &Value) -> Value {
    merge_deep_right(defaults, user)
}
