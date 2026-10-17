//! The capture's validator suite, ported: required fields, the eight rate-limit paths, the
//! adaptive-pow matrix, the event-store cases, the shape rules and the admin-notification
//! rules. Each test names what `test/unit/utils/settings-config.spec.ts` asserted.

use std::fs;

use nostream_config::load::merge;
use nostream_config::path::set_by_path;
use nostream_config::validate_document;
use nostream_config::value::merge_deep_right;
use serde_yaml::Value;

fn defaults() -> Value {
    let raw = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../resources/default-settings.yaml"
    ))
    .expect("the shipped defaults are readable");
    serde_yaml::from_str(&raw).expect("the shipped defaults are valid YAML")
}

/// The capture's test base: the required fields and an empty `network` section.
fn minimal() -> Value {
    serde_yaml::from_str("info:\n  relay_url: wss://test.relay\n  name: test\nnetwork: {}\n")
        .expect("the minimal document parses")
}

fn patched(patch: &str) -> Value {
    let patch: Value = serde_yaml::from_str(patch).expect("the patch parses");
    merge(&minimal(), &patch)
}

fn issues(document: &Value) -> Vec<String> {
    validate_document(document, &defaults())
        .into_iter()
        .map(|issue| issue.to_string())
        .collect()
}

fn paths(document: &Value) -> Vec<String> {
    validate_document(document, &defaults())
        .into_iter()
        .map(|issue| issue.path)
        .collect()
}

#[test]
fn basic_required_fields_are_reported() {
    let document: Value = serde_yaml::from_str("{}").expect("empty document");
    assert_eq!(
        issues(&document),
        vec![
            "info.relay_url: relay_url is required",
            "info.name: name is required",
            "network: network section is required",
        ]
    );
}

// --- the eight rate-limit paths ---------------------------------------------------------

#[test]
fn rejects_a_non_positive_period_on_limits_event_rate_limits() {
    let document =
        patched("limits:\n  event:\n    rateLimits:\n      - period: 0\n        rate: 1\n");
    assert_eq!(
        paths(&document),
        vec!["limits.event.rateLimits[0].period".to_owned()]
    );
}

#[test]
fn rejects_a_non_positive_period_on_limits_message_rate_limits() {
    let document =
        patched("limits:\n  message:\n    rateLimits:\n      - period: 0\n        rate: 1\n");
    assert_eq!(
        paths(&document),
        vec!["limits.message.rateLimits[0].period".to_owned()]
    );
}

#[test]
fn rejects_a_non_positive_period_on_limits_connection_rate_limits() {
    let document =
        patched("limits:\n  connection:\n    rateLimits:\n      - period: -1\n        rate: 1\n");
    assert_eq!(
        paths(&document),
        vec!["limits.connection.rateLimits[0].period".to_owned()]
    );
}

#[test]
fn rejects_a_non_positive_period_on_limits_invoice_rate_limits() {
    let document =
        patched("limits:\n  invoice:\n    rateLimits:\n      - period: 0\n        rate: 1\n");
    assert_eq!(
        paths(&document),
        vec!["limits.invoice.rateLimits[0].period".to_owned()]
    );
}

#[test]
fn rejects_a_non_positive_period_on_limits_admission_check_rate_limits() {
    let document = patched(
        "limits:\n  admissionCheck:\n    rateLimits:\n      - period: 0\n        rate: 1\n",
    );
    assert_eq!(
        paths(&document),
        vec!["limits.admissionCheck.rateLimits[0].period".to_owned()]
    );
}

#[test]
fn rejects_a_non_positive_period_on_limits_invite_rate_limits() {
    let document =
        patched("limits:\n  invite:\n    rateLimits:\n      - period: 0\n        rate: 1\n");
    assert_eq!(
        paths(&document),
        vec!["limits.invite.rateLimits[0].period".to_owned()]
    );
}

#[test]
fn rejects_a_non_positive_period_on_limits_admin_rate_limits() {
    let document =
        patched("limits:\n  admin:\n    rateLimits:\n      - period: 0\n        rate: 1\n");
    assert_eq!(
        paths(&document),
        vec!["limits.admin.rateLimits[0].period".to_owned()]
    );
}

#[test]
fn rejects_a_non_positive_period_on_limits_admin_login_rate_limits() {
    let document =
        patched("limits:\n  admin:\n    loginRateLimits:\n      - period: -1\n        rate: 1\n");
    assert_eq!(
        paths(&document),
        vec!["limits.admin.loginRateLimits[0].period".to_owned()]
    );
}

#[test]
fn accepts_a_positive_period() {
    let document =
        patched("limits:\n  event:\n    rateLimits:\n      - period: 60000\n        rate: 10\n");
    assert_eq!(paths(&document), Vec::<String>::new());
}

#[test]
fn rejects_a_null_entry_in_a_rate_limit_array_without_throwing() {
    let document = patched("limits:\n  event:\n    rateLimits:\n      - null\n");
    let reported = issues(&document);
    assert!(
        reported
            .contains(&"limits.event.rateLimits[0]: rateLimits entry must be an object".to_owned())
    );
    assert!(
        reported.contains(
            &"limits.event.rateLimits[0]: Array element does not match expected schema shape"
                .to_owned()
        ),
        "the shape walk also rejects the entry, as the capture's does"
    );
}

#[test]
fn rejects_a_scalar_entry_in_a_rate_limit_array() {
    let document = patched("limits:\n  event:\n    rateLimits:\n      - 42\n");
    let reported = issues(&document);
    assert!(
        reported
            .contains(&"limits.event.rateLimits[0]: rateLimits entry must be an object".to_owned())
    );
    assert!(
        reported.contains(
            &"limits.event.rateLimits[0]: Array element does not match expected schema shape"
                .to_owned()
        )
    );
}

#[test]
fn a_non_array_rate_limits_value_is_left_to_the_shape_validator() {
    let document = patched("limits:\n  event:\n    rateLimits: {}\n");
    assert_eq!(
        issues(&document),
        vec!["limits.event.rateLimits: Expected array, got object"]
    );
}

// --- adaptive pow -----------------------------------------------------------------------

fn pow_with(overrides: &[(&str, Value)]) -> Value {
    let mut document = patched(
        "limits:\n  event:\n    pow:\n      enabled: true\n      floorBits: 8\n      ceilingBits: 24\n      targetEventsPerSecond: 10\n      periodMs: 60000\n",
    );
    for (path, value) in overrides {
        document = set_by_path(
            &document,
            &format!("limits.event.pow.{path}"),
            value.clone(),
        )
        .expect("the pow path is writable");
    }
    document
}

fn number(number: u64) -> Value {
    Value::Number(number.into())
}

fn threshold(max_distance: i64, difficulty_factor: f64) -> Value {
    serde_yaml::from_str(&format!(
        "maxDistance: {max_distance}\ndifficultyFactor: {difficulty_factor}\n"
    ))
    .expect("threshold parses")
}

#[test]
fn accepts_a_valid_pow_config() {
    assert_eq!(paths(&pow_with(&[])), Vec::<String>::new());
}

#[test]
fn rejects_floor_bits_greater_than_ceiling_bits() {
    let document = pow_with(&[("floorBits", number(20)), ("ceilingBits", number(10))]);
    assert!(paths(&document).contains(&"limits.event.pow.floorBits".to_owned()));
}

#[test]
fn rejects_a_negative_floor_bits() {
    let document = pow_with(&[("floorBits", Value::Number((-1).into()))]);
    assert!(paths(&document).contains(&"limits.event.pow.floorBits".to_owned()));
}

#[test]
fn rejects_a_ceiling_bits_above_256() {
    let document = pow_with(&[("ceilingBits", number(300))]);
    assert_eq!(
        paths(&document),
        vec!["limits.event.pow.ceilingBits".to_owned()]
    );
}

#[test]
fn accepts_a_ceiling_bits_of_exactly_256() {
    let document = pow_with(&[("ceilingBits", number(256)), ("floorBits", number(0))]);
    assert!(!paths(&document).contains(&"limits.event.pow.ceilingBits".to_owned()));
}

#[test]
fn rejects_a_non_positive_period_ms() {
    let document = pow_with(&[("periodMs", number(0))]);
    assert_eq!(
        paths(&document),
        vec!["limits.event.pow.periodMs".to_owned()]
    );
}

#[test]
fn rejects_a_non_positive_target_events_per_second() {
    let document = pow_with(&[("targetEventsPerSecond", number(0))]);
    assert_eq!(
        paths(&document),
        vec!["limits.event.pow.targetEventsPerSecond".to_owned()]
    );
}

#[test]
fn skips_pow_validation_entirely_when_disabled() {
    let document = patched(
        "limits:\n  event:\n    pow:\n      enabled: false\n      floorBits: -1\n      periodMs: -1\n",
    );
    assert!(
        !paths(&document)
            .iter()
            .any(|path| path.starts_with("limits.event.pow"))
    );
}

#[test]
fn accepts_valid_wot_thresholds() {
    let document = pow_with(&[(
        "wotThresholds",
        Value::Sequence(vec![threshold(1, 0.0), threshold(2, 0.5)]),
    )]);
    assert!(
        !paths(&document)
            .iter()
            .any(|path| path.starts_with("limits.event.pow.wotThresholds"))
    );
}

#[test]
fn rejects_a_negative_wot_threshold_max_distance() {
    let document = pow_with(&[("wotThresholds", Value::Sequence(vec![threshold(-1, 0.5)]))]);
    assert_eq!(
        paths(&document),
        vec!["limits.event.pow.wotThresholds[0].maxDistance".to_owned()]
    );
}

#[test]
fn rejects_a_difficulty_factor_outside_the_unit_interval() {
    let document = pow_with(&[(
        "wotThresholds",
        Value::Sequence(vec![threshold(1, -0.1), threshold(2, 1.1)]),
    )]);
    assert_eq!(
        paths(&document),
        vec![
            "limits.event.pow.wotThresholds[0].difficultyFactor".to_owned(),
            "limits.event.pow.wotThresholds[1].difficultyFactor".to_owned(),
        ]
    );
}

#[test]
fn rejects_null_and_non_object_wot_threshold_entries_without_throwing() {
    let document = pow_with(&[(
        "wotThresholds",
        Value::Sequence(vec![Value::Null, number(42)]),
    )]);
    assert_eq!(
        issues(&document),
        vec![
            "limits.event.pow.wotThresholds[0]: wotThresholds entry must be an object",
            "limits.event.pow.wotThresholds[1]: wotThresholds entry must be an object",
        ]
    );
}

// --- event store ------------------------------------------------------------------------

#[test]
fn ships_postgres_as_the_default_backend() {
    let defaults = defaults();
    assert_eq!(
        nostream_config::path::get_by_path(&defaults, "eventStore.backend")
            .expect("path parses")
            .expect("the backend is set"),
        &Value::String("postgres".to_owned())
    );
}

#[test]
fn accepts_settings_without_an_event_store_section() {
    assert!(
        !paths(&minimal())
            .iter()
            .any(|path| path.starts_with("eventStore"))
    );
}

#[test]
fn accepts_the_postgres_backend() {
    let document = patched("eventStore:\n  backend: postgres\n");
    assert!(
        !paths(&document)
            .iter()
            .any(|path| path.starts_with("eventStore"))
    );
}

#[test]
fn rejects_an_unsupported_backend() {
    let document = patched("eventStore:\n  backend: mongodb\n");
    assert_eq!(
        issues(&document),
        vec!["eventStore.backend: backend must be one of: postgres, lmdb"]
    );
}

// --- the shape rules --------------------------------------------------------------------

#[test]
fn rejects_an_unknown_top_level_key() {
    let document = patched("bogusSection: {}\n");
    assert_eq!(issues(&document), vec!["bogusSection: Unknown setting key"]);
}

#[test]
fn rejects_an_unknown_nested_key() {
    let document = patched("info:\n  unknownKey: 1\n");
    assert_eq!(
        issues(&document),
        vec!["info.unknownKey: Unknown setting key"]
    );
}

#[test]
fn rejects_a_wrong_scalar_type() {
    let document = patched("workers:\n  count: four\n");
    assert_eq!(
        issues(&document),
        vec!["workers.count: Expected number, got string"]
    );
}

#[test]
fn rejects_an_array_where_the_schema_is_an_object() {
    let document = patched("network: []\n");
    assert_eq!(
        issues(&document),
        vec!["network: Expected object, got object"]
    );
}

#[test]
fn rejects_null_where_the_schema_is_not_null() {
    let document = patched("workers:\n  count: null\n");
    assert_eq!(
        issues(&document),
        vec!["workers.count: Expected number, got null"]
    );
}

#[test]
fn rejects_an_array_element_that_matches_no_schema_entry() {
    let document = patched("network:\n  trustedProxies:\n    - 1\n");
    assert_eq!(
        issues(&document),
        vec!["network.trustedProxies[0]: Array element does not match expected schema shape"]
    );
}

#[test]
fn the_shape_walk_skips_admin_password_hash() {
    let defaults = defaults();
    let document = set_by_path(
        &defaults,
        "admin.passwordHash",
        Value::String("$2b$10$hash".to_owned()),
    )
    .expect("passwordHash is writable");
    assert_eq!(validate_document(&document, &defaults), Vec::new());
}

#[test]
fn renders_the_document_root_as_a_dollar_sign() {
    let document = Value::String("not a document".to_owned());
    assert!(issues(&document).contains(&"$: Expected object, got string".to_owned()));
}

// --- admin notifications ----------------------------------------------------------------

fn notifications(extra: &str) -> Value {
    let patch = format!("admin:\n  notifications:\n{extra}");
    patched(&patch)
}

#[test]
fn rejects_retry_max_attempts_below_one() {
    let document = notifications("    retry:\n      maxAttempts: 0\n");
    assert_eq!(
        issues(&document),
        vec!["admin.notifications.retry.maxAttempts: maxAttempts must be at least 1"]
    );
}

#[test]
fn rejects_a_negative_base_delay() {
    let document = notifications("    retry:\n      baseDelayMs: -1\n");
    assert_eq!(
        issues(&document),
        vec!["admin.notifications.retry.baseDelayMs: baseDelayMs must be >= 0"]
    );
}

#[test]
fn rejects_a_retention_below_one_day() {
    let document = notifications("    deliveryLogRetentionDays: 0\n");
    assert_eq!(
        issues(&document),
        vec![
            "admin.notifications.deliveryLogRetentionDays: deliveryLogRetentionDays must be at least 1"
        ]
    );
}

#[test]
fn rejects_targets_that_are_not_an_array() {
    let document = notifications("    targets: {}\n");
    assert_eq!(
        issues(&document),
        vec![
            "admin.notifications.targets: Expected array, got object",
            "admin.notifications.targets: targets must be an array",
        ]
    );
}

#[test]
fn rejects_a_target_that_is_not_an_object() {
    let document = notifications("    targets:\n      - 42\n");
    assert_eq!(
        issues(&document),
        vec!["admin.notifications.targets[0]: target must be an object"]
    );
}

#[test]
fn rejects_a_target_without_an_id() {
    let document =
        notifications("    targets:\n      - type: http\n        url: https://a.example\n");
    assert_eq!(
        issues(&document),
        vec!["admin.notifications.targets[0].id: target id is required"]
    );
}

#[test]
fn rejects_duplicate_target_ids() {
    let document = notifications(
        "    targets:\n      - id: dup\n        type: http\n        url: https://a.example\n      - id: dup\n        type: http\n        url: https://b.example\n",
    );
    assert_eq!(
        issues(&document),
        vec!["admin.notifications.targets[1].id: target id must be unique"]
    );
}

#[test]
fn rejects_an_unknown_target_type() {
    let document = notifications("    targets:\n      - id: a\n        type: carrier-pigeon\n");
    assert_eq!(
        issues(&document),
        vec!["admin.notifications.targets[0].type: type must be http, discord, slack, or telegram"]
    );
}

#[test]
fn rejects_a_non_boolean_enabled_flag() {
    let document = notifications(
        "    targets:\n      - id: a\n        type: telegram\n        enabled: yes-please\n        botToken: t\n        chatId: c\n",
    );
    assert_eq!(
        issues(&document),
        vec!["admin.notifications.targets[0].enabled: enabled must be a boolean"]
    );
}

#[test]
fn requires_telegram_credentials() {
    let document = notifications("    targets:\n      - id: t1\n        type: telegram\n");
    assert_eq!(
        issues(&document),
        vec![
            "admin.notifications.targets[0].botToken: botToken is required for telegram targets",
            "admin.notifications.targets[0].chatId: chatId is required for telegram targets",
        ]
    );
}

#[test]
fn requires_a_url_for_webhook_targets() {
    let document = notifications("    targets:\n      - id: w1\n        type: http\n");
    assert_eq!(
        issues(&document),
        vec!["admin.notifications.targets[0].url: url is required for webhook targets"]
    );
}

#[test]
fn rejects_a_webhook_url_with_a_non_http_protocol() {
    let document = notifications(
        "    targets:\n      - id: w1\n        type: http\n        url: ftp://bad.example\n",
    );
    assert_eq!(
        issues(&document),
        vec!["admin.notifications.targets[0].url: url must use http or https"]
    );
}

#[test]
fn rejects_a_url_that_does_not_parse() {
    let document = notifications(
        "    targets:\n      - id: w1\n        type: slack\n        url: not a url\n",
    );
    assert_eq!(
        issues(&document),
        vec!["admin.notifications.targets[0].url: url must be a valid URL"]
    );
}

#[test]
fn accepts_a_well_formed_http_target() {
    let document = notifications(
        "    targets:\n      - id: w1\n        type: http\n        enabled: true\n        url: https://a.example/hook\n",
    );
    assert_eq!(issues(&document), Vec::<String>::new());
}

#[test]
fn merge_deep_right_replaces_arrays_and_null() {
    let defaults: Value =
        serde_yaml::from_str("a:\n  b: 1\n  list:\n    - 1\n    - 2\n  keep: x\n").expect("doc");
    let user: Value = serde_yaml::from_str("a:\n  list:\n    - 9\n  keep: null\n").expect("doc");
    let merged = merge_deep_right(&defaults, &user);
    assert_eq!(
        nostream_config::path::get_by_path(&merged, "a.list")
            .expect("path")
            .cloned(),
        Some(serde_yaml::from_str::<Value>("[9]").expect("seq"))
    );
    assert_eq!(
        nostream_config::path::get_by_path(&merged, "a.keep")
            .expect("path")
            .cloned(),
        Some(Value::Null)
    );
    assert_eq!(
        nostream_config::path::get_by_path(&merged, "a.b")
            .expect("path")
            .cloned(),
        Some(Value::Number(1.into()))
    );
}
