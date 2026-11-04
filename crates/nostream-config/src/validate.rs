//! The settings validator. Mirrors `src/utils/settings-config.ts` `validateSettings` and
//! `validateShape` at the capture commit, including issue order and message text.
//!
//! Order is part of the contract: the semantic rules run first, then the defaults document is
//! walked as a schema, then the admin-notification rules. Two behaviours are load-bearing:
//! unknown keys are rejected at every depth, and the shipped defaults are the schema, so the
//! defaults file is part of the contract rather than just data.

use nostream_core::EventStoreBackend;
use serde_yaml::Value;
use url::Url;

use crate::error::ConfigError;
use crate::issue::Issue;
use crate::path::{PathToken, format_path_tokens};
use crate::settings::Settings;
use crate::value::{
    compare_le, is_nil, is_plain_object, js_typeof, key, key_path, merge_deep_right, number_ge,
    number_le, number_lt, to_number, truthy_opt,
};

/// `frame_queue_bytes`, the per-socket outbound queue `RelayConfig::default` sets
/// (`crates/nostream-relay/src/relay.rs:85`): 8 MiB. Repeated here because `nostream-config`
/// cannot depend on `nostream-relay`, and the cap's ceiling is derived from it.
// shortcut: the 8 MiB is repeated rather than shared with `nostream-relay`; upgrade when the
// relay's default can be named from this crate, or a test pins `frame_queue_bytes` (ADR 0009).
const FRAME_QUEUE_BYTES: u64 = 8 * 1024 * 1024;

/// The largest `network.frameMemoryBudgetBytes` the validator accepts: 1 TiB.
/// `FrameBudget::admit` guards with `saturating_sub` and then adds unchecked
/// (`crates/nostream-relay/src/sink.rs:164`), so a budget near `usize::MAX` makes the guard
/// untrippable and the add overflow. 1 TiB is 0.000006 % of `usize::MAX` (a factor of
/// 16 777 215): a safety valve against a stray digit, not a deployment figure (ADR 0009).
pub const MAX_FRAME_MEMORY_BUDGET_BYTES: u64 = 1024 * 1024 * 1024 * 1024;

/// The largest `limits.connection.maxConnectionsPerIp` the validator accepts: 131 072, the
/// sockets whose full [`FRAME_QUEUE_BYTES`] queues exactly exhaust
/// [`MAX_FRAME_MEMORY_BUDGET_BYTES`] — 2^40 / 2^23 = 2^17 = 131 072 exactly, an absolute
/// maximum the budget's ceiling implies rather than a figure argued for. The cap is compared,
/// never added (`crates/nostream-relay/src/connection_cap.rs:76`), so it needs no `usize`
/// headroom of its own.
pub const MAX_CONNECTIONS_PER_IP: u64 = MAX_FRAME_MEMORY_BUDGET_BYTES / FRAME_QUEUE_BYTES;

/// Validates a settings document against a defaults document.
///
/// `candidate` is the merged settings (defaults deep-merged with the user's overrides);
/// `defaults` is the shipped defaults document, used as the schema.
pub fn validate_document(candidate: &Value, defaults: &Value) -> Vec<Issue> {
    let mut issues = Vec::new();

    if !truthy_opt(key_path(candidate, &["info", "relay_url"])) {
        issues.push(Issue::new("info.relay_url", "relay_url is required"));
    } else if let Some(Value::String(value)) = key_path(candidate, &["info", "relay_url"]) {
        // Order matters and is the capture's: parse, then host, then scheme. A
        // string that is not an absolute URL reports once, as unparseable, rather
        // than three times.
        match Url::parse(value) {
            Ok(parsed) => {
                if parsed.host_str().is_none_or(str::is_empty) {
                    issues.push(Issue::new(
                        "info.relay_url",
                        "relay_url must include a valid host",
                    ));
                } else if !matches!(parsed.scheme(), "ws" | "wss" | "http" | "https") {
                    issues.push(Issue::new(
                        "info.relay_url",
                        "relay_url must use ws, wss, http, or https protocol",
                    ));
                }
            }
            Err(_) => issues.push(Issue::new(
                "info.relay_url",
                "relay_url must be a valid absolute URL",
            )),
        }
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
    if truthy_opt(strategy)
        && !matches!(strategy, Some(Value::String(name)) if name == "ewma" || name == "sliding_window")
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

    // The two bounds the relay reads at run time are numerical settings before they are anything
    // else, so a stated value outside `1..=ceiling` is refused here, by name, exactly as the
    // adaptive-pow numbers below are: absent still means the compiled default, and a stated value
    // is a literal the operator wrote (ADRs 0008 and 0009). Only a JSON number takes these rules:
    // `to_number` reads a null, a boolean and a numeric string as numbers too, and a wrong type is
    // the shape walk's one finding to make — two issues for one key would leave the operator to
    // guess which to fix.
    if let Some(budget @ Value::Number(_)) =
        key_path(candidate, &["network", "frameMemoryBudgetBytes"])
        && !to_number_is_positive(Some(budget))
    {
        issues.push(Issue::new(
            "network.frameMemoryBudgetBytes",
            "frameMemoryBudgetBytes must be greater than 0",
        ));
    }

    // The ceiling, in the zero rule's shape: the literal number below is the constant's value,
    // and the whole-issue-vector test is what keeps the two in step (ADR 0009).
    if let Some(budget @ Value::Number(number)) =
        key_path(candidate, &["network", "frameMemoryBudgetBytes"])
        && !number_le(Some(budget), MAX_FRAME_MEMORY_BUDGET_BYTES as f64)
    {
        issues.push(Issue::new(
            "network.frameMemoryBudgetBytes",
            format!(
                "the file states {number}; frameMemoryBudgetBytes must be at most 1099511627776"
            ),
        ));
    }

    if let Some(cap @ Value::Number(_)) =
        key_path(candidate, &["limits", "connection", "maxConnectionsPerIp"])
        && !to_number_is_positive(Some(cap))
    {
        issues.push(Issue::new(
            "limits.connection.maxConnectionsPerIp",
            "maxConnectionsPerIp must be greater than 0",
        ));
    }

    // The same word at the other end, and the same literal.
    if let Some(cap @ Value::Number(number)) =
        key_path(candidate, &["limits", "connection", "maxConnectionsPerIp"])
        && !number_le(Some(cap), MAX_CONNECTIONS_PER_IP as f64)
    {
        issues.push(Issue::new(
            "limits.connection.maxConnectionsPerIp",
            format!("the file states {number}; maxConnectionsPerIp must be at most 131072"),
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
        validate_rate_limit_periods(
            key_path(limits, &["event", "rateLimits"]),
            "limits.event.rateLimits",
            &mut issues,
        );
        validate_rate_limit_periods(
            key_path(limits, &["message", "rateLimits"]),
            "limits.message.rateLimits",
            &mut issues,
        );
        validate_rate_limit_periods(
            key_path(limits, &["connection", "rateLimits"]),
            "limits.connection.rateLimits",
            &mut issues,
        );
        validate_rate_limit_periods(
            key_path(limits, &["invoice", "rateLimits"]),
            "limits.invoice.rateLimits",
            &mut issues,
        );
        validate_rate_limit_periods(
            key_path(limits, &["admissionCheck", "rateLimits"]),
            "limits.admissionCheck.rateLimits",
            &mut issues,
        );
        validate_rate_limit_periods(
            key_path(limits, &["invite", "rateLimits"]),
            "limits.invite.rateLimits",
            &mut issues,
        );
        validate_rate_limit_periods(
            key_path(limits, &["admin", "rateLimits"]),
            "limits.admin.rateLimits",
            &mut issues,
        );
        validate_rate_limit_periods(
            key_path(limits, &["admin", "loginRateLimits"]),
            "limits.admin.loginRateLimits",
            &mut issues,
        );
    }

    // `nip66` retention, `nip77` caps, subscription plans and peering are modelled by the
    // typed settings above but were not validated: the document is shared with the
    // TypeScript app, which rejects these documents, so `config validate` blessing them
    // would leave one file with two verdicts.
    if let Some(nip66) = key(candidate, "nip66")
        && let Some(Value::Number(hours)) = key(nip66, "historyRetentionHours")
    {
        let whole = hours.as_i64().is_some() || hours.as_f64().is_some_and(|f| f.fract() == 0.0);
        let value = to_number(&Value::Number(hours.clone())).unwrap_or(-1.0);
        if !whole || !(value == 0.0 || value >= 1.0) {
            issues.push(Issue::new(
                "nip66.historyRetentionHours",
                "historyRetentionHours must be 0 (disabled) or at least 1",
            ));
        }
    }

    if let Some(nip77) = key(candidate, "nip77")
        && truthy_opt(key(nip77, "enabled"))
    {
        // Wrong types are the shape walk's to report; this rule is about the value.
        for field in [
            "maxEventsPerSession",
            "maxSessionsPerConnection",
            "sessionIdleTimeoutMs",
        ] {
            if let Some(Value::Number(number)) = key(nip77, field) {
                let value = to_number(&Value::Number(number.clone())).unwrap_or(-1.0);
                let whole = number.as_i64().is_some()
                    || number.as_u64().is_some()
                    || number.as_f64().is_some_and(|f| f.fract() == 0.0);
                if !whole || value <= 0.0 {
                    issues.push(Issue::new(
                        format!("nip77.{field}"),
                        format!("{field} must be a positive integer"),
                    ));
                }
            }
        }
    }

    validate_subscription_plans(candidate, &mut issues);
    validate_peering(candidate, &mut issues);

    validate_shape(defaults, Some(candidate), &[], &mut issues);
    issues.extend(validate_admin_notifications(candidate));

    issues
}

fn to_number_is_positive(value: Option<&Value>) -> bool {
    value.and_then(to_number).is_some_and(|number| number > 0.0)
}

fn is_event_store_backend(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(name)) if EventStoreBackend::parse(name).is_some())
}

fn validate_rate_limit_periods(
    rate_limits: Option<&Value>,
    path_prefix: &str,
    issues: &mut Vec<Issue>,
) {
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
        let period_path = format!("{path_prefix}[{index}].period");
        match key(entry, "period") {
            // Three mistakes, three messages, in the capture's order: not a number,
            // not a whole number, not at least one. A window of 60 ms is a valid
            // count and stays valid; the unit cannot be inferred from the value.
            Some(Value::Number(number)) => {
                let integral = number.as_i64().is_some()
                    || number.as_u64().is_some()
                    || number.as_f64().is_some_and(|float| float.fract() == 0.0);
                if !integral {
                    issues.push(Issue::new(
                        period_path,
                        "period must be a whole number of milliseconds",
                    ));
                } else if !to_number_is_positive(Some(&Value::Number(number.clone()))) {
                    issues.push(Issue::new(
                        period_path,
                        "period must be at least 1 millisecond",
                    ));
                }
            }
            _ => issues.push(Issue::new(
                period_path,
                "period must be a number of milliseconds",
            )),
        }
    }
}

/// Walks the defaults document as the schema for the candidate.
/// `payments.subscriptionPlans` — the same rules as `validateSubscriptionPlans`.
///
/// A plan is selected by the amount paid, so the amount is both validated and required to be
/// unique: two plans at one price cannot be told apart by a payment.
fn validate_subscription_plans(candidate: &Value, issues: &mut Vec<Issue>) {
    let Some(Value::Sequence(plans)) = key_path(candidate, &["payments", "subscriptionPlans"])
    else {
        return;
    };
    let mut ids: Vec<String> = Vec::new();
    let mut amounts: Vec<String> = Vec::new();
    for (index, plan) in plans.iter().enumerate() {
        let prefix = format!("payments.subscriptionPlans[{index}]");
        if !is_plain_object(plan) {
            issues.push(Issue::new(prefix, "plan must be an object"));
            continue;
        }
        match key(plan, "id") {
            Some(Value::String(id)) if !id.trim().is_empty() => {
                if id == "grandfathered" {
                    issues.push(Issue::new(
                        format!("{prefix}.id"),
                        "id \"grandfathered\" is reserved",
                    ));
                } else if ids.contains(id) {
                    issues.push(Issue::new(
                        format!("{prefix}.id"),
                        format!("id \"{id}\" is used by more than one plan"),
                    ));
                } else {
                    ids.push(id.clone());
                }
            }
            _ => issues.push(Issue::new(format!("{prefix}.id"), "id is required")),
        }
        let amount = key(plan, "amount");
        if !to_number_is_positive(amount) {
            issues.push(Issue::new(
                format!("{prefix}.amount"),
                "amount must be a positive integer (msats)",
            ));
        } else if let Some(value) = amount.and_then(serde_yaml::Value::as_i64) {
            let text = value.to_string();
            if amounts.contains(&text) {
                issues.push(Issue::new(
                    format!("{prefix}.amount"),
                    format!("amount {value} is used by more than one plan"),
                ));
            } else {
                amounts.push(text);
            }
        }
        if !to_number_is_positive(key(plan, "intervalSeconds")) {
            issues.push(Issue::new(
                format!("{prefix}.intervalSeconds"),
                "intervalSeconds must be a positive integer",
            ));
        }
        if !to_number_is_positive(key(plan, "graceSeconds")) {
            issues.push(Issue::new(
                format!("{prefix}.graceSeconds"),
                "graceSeconds must be a positive integer",
            ));
        }
    }
}

/// `peering` — the discovery surface the NIP-11 document publishes.
///
/// The scopes, terms and peers graphs are not validated here yet; a configuration that is
/// accepted here and rejected by the TypeScript app is the state this whole rule set exists to
/// end, so what is missing is named in the issue that tracks the port.
fn validate_peering(candidate: &Value, issues: &mut Vec<Issue>) {
    let Some(peering) = key(candidate, "peering") else {
        return;
    };
    if !is_plain_object(peering) {
        return;
    }
    if let Some(Value::Number(bits)) = key(peering, "minRequestPowDifficulty") {
        let value = to_number(&Value::Number(bits.clone())).unwrap_or(-1.0);
        let whole = bits.as_i64().is_some() || bits.as_f64().is_some_and(|f| f.fract() == 0.0);
        if !whole || !(0.0..=256.0).contains(&value) {
            issues.push(Issue::new(
                "peering.minRequestPowDifficulty",
                "must be an integer between 0 and 256",
            ));
        }
    }
    if let Some(Value::String(endpoint)) = key(peering, "endpoint")
        && !endpoint.trim().is_empty()
    {
        match Url::parse(endpoint.trim()) {
            Ok(parsed) => {
                if !matches!(parsed.scheme(), "ws" | "wss")
                    || parsed.host_str().is_none_or(str::is_empty)
                {
                    issues.push(Issue::new(
                        "peering.endpoint",
                        "must be a ws:// or wss:// URL",
                    ));
                }
            }
            Err(_) => issues.push(Issue::new(
                "peering.endpoint",
                "must be a valid ws:// or wss:// URL",
            )),
        }
    }
    if let Some(Value::String(contact)) = key(peering, "contact")
        && !contact.trim().is_empty()
        && Url::parse(contact.trim()).is_err()
    {
        issues.push(Issue::new(
            "peering.contact",
            "must be a valid URI (for example mailto: or https:)",
        ));
    }
    if truthy_opt(key(peering, "enabled")) {
        let scopes = key(peering, "scopes");
        let has_scopes = matches!(scopes, Some(Value::Sequence(entries)) if !entries.is_empty());
        if !has_scopes {
            issues.push(Issue::new(
                "peering.scopes",
                "at least one scope is required when peering is enabled",
            ));
        }
        let has_contact =
            matches!(key(peering, "contact"), Some(Value::String(text)) if !text.trim().is_empty());
        let has_endpoint = matches!(key(peering, "endpoint"), Some(Value::String(text)) if !text.trim().is_empty());
        if !has_contact && !has_endpoint {
            issues.push(Issue::new(
                "peering.contact",
                "contact or endpoint is required when peering is enabled",
            ));
        }
    }
}

fn validate_shape(
    schema: &Value,
    candidate: Option<&Value>,
    path: &[PathToken],
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
                    let mut local_path = path.to_vec();
                    local_path.push(PathToken::Index(index));
                    validate_shape(schema_entry, Some(entry), &local_path, &mut local_issues);
                    local_issues.is_empty()
                });

                if !matches_any {
                    let mut issue_path = path.to_vec();
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
                    let mut issue_path = path.to_vec();
                    issue_path.push(PathToken::Key(key.to_owned()));
                    issues.push(Issue::new(
                        format_path_tokens(&issue_path),
                        "Unknown setting key",
                    ));
                }
            }

            for (key, schema_value) in schema_mapping {
                let Some(key) = key.as_str() else {
                    continue;
                };
                let mut child_path = path.to_vec();
                child_path.push(PathToken::Key(key.to_owned()));
                validate_shape(schema_value, candidates.get(key), &child_path, issues);
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
                    format!(
                        "Expected {}, got {}",
                        js_typeof(schema),
                        js_typeof(candidate)
                    ),
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
                    issues.push(Issue::new(
                        format!("{prefix}.id"),
                        "target id must be unique",
                    ));
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
            issues.push(Issue::new(
                format!("{prefix}.enabled"),
                "enabled must be a boolean",
            ));
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
                        UrlCheck::Invalid => issues.push(Issue::new(
                            format!("{prefix}.url"),
                            "url must be a valid URL",
                        )),
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

/// Classifies one notification URL the way the capture does: `new URL(target.url)` inside
/// `try`, then the protocol check on the parsed result.
///
/// The parse is the WHATWG parser rather than a hand-rolled scan, so the check refuses what
/// the capture refuses — a port outside 1–65535 (`https://hooks.example:99999/hook`), a space
/// in the host (`https://bad host/hook`) — instead of only requiring something after `//`.
/// The parser also strips leading and trailing C0 controls and spaces, as `new URL()` does,
/// so the raw text is passed through untrimmed.
fn check_webhook_url(raw: &str) -> UrlCheck {
    match Url::parse(raw) {
        Ok(parsed) if parsed.scheme() == "http" || parsed.scheme() == "https" => UrlCheck::Ok,
        Ok(_) => UrlCheck::BadProtocol,
        Err(_) => UrlCheck::Invalid,
    }
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
