//! Defaults parity with `test/unit/utils/settings.spec.ts:226-341` at the capture commit:
//! six defaults assertions and four override cases, value for value.

use std::fs;

use nostream_config::load::merge;
use nostream_config::path::get_by_path;
use serde_yaml::Value;

fn defaults() -> Value {
    let raw = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../resources/default-settings.yaml"
    ))
    .expect("the shipped defaults are readable");
    serde_yaml::from_str(&raw).expect("the shipped defaults are valid YAML")
}

fn value(document: &Value, path: &str) -> Value {
    get_by_path(document, path)
        .expect("the path parses")
        .unwrap_or_else(|| panic!("{path} exists")) 
        .clone()
}

fn assert_value(document: &Value, path: &str, expected: Value) {
    assert_eq!(value(document, path), expected, "{path}");
}

fn boolean(boolean: bool) -> Value {
    Value::Bool(boolean)
}

fn number(number: u64) -> Value {
    Value::Number(number.into())
}

#[test]
fn nip43_defaults_are_the_capture_mint_defaults() {
    let defaults = defaults();
    assert_value(&defaults, "nip43.enabled", boolean(false));
    assert_value(&defaults, "nip43.inviteCodeExpirySeconds", number(600));
    assert_value(&defaults, "nip43.defaultMaxUses", number(1));
    assert_value(&defaults, "nip43.allowInviteRequests", boolean(false));
    assert_value(&defaults, "nip43.inviteRequestWhitelist", Value::Sequence(vec![]));
}

#[test]
fn nip43_invite_rate_limit_is_per_pubkey() {
    let defaults = defaults();
    let rate_limits = get_by_path(&defaults, "limits.invite.rateLimits")
        .expect("path parses")
        .expect("the list exists");
    let Value::Sequence(entries) = rate_limits else {
        panic!("limits.invite.rateLimits is a sequence");
    };
    assert_eq!(entries.len(), 1);
    assert_value(&defaults, "limits.invite.rateLimits[0].period", number(3_600_000));
    assert_value(&defaults, "limits.invite.rateLimits[0].rate", number(5));
}

#[test]
fn info_self_is_left_unset_so_it_is_derived() {
    let defaults = defaults();
    assert!(
        get_by_path(&defaults, "info.self")
            .expect("path parses")
            .is_none(),
        "info.self must not be shipped; it is derived from SECRET"
    );
}

#[test]
fn nip66_defaults_are_safe() {
    let defaults = defaults();
    assert_value(&defaults, "nip66.enabled", boolean(false));
    assert_value(&defaults, "nip66.probeIntervalSeconds", number(3600));
    assert_value(&defaults, "nip66.timeouts.dnsMs", number(10_000));
    assert_value(&defaults, "nip66.timeouts.tlsMs", number(10_000));
    assert_value(&defaults, "nip66.timeouts.wsRttMs", number(10_000));
    assert_value(&defaults, "nip66.timeouts.nip11Ms", number(10_000));
    assert_value(&defaults, "nip66.targets", Value::Sequence(vec![]));
    assert_value(&defaults, "nip66.dnsCacheTtlSeconds", number(300));
}

#[test]
fn wot_defaults_are_disabled() {
    let defaults = defaults();
    assert_value(&defaults, "wot.enabled", boolean(false));
    assert_value(&defaults, "wot.seedPubkey", Value::String(String::new()));
    assert_value(&defaults, "wot.minimumFollowers", number(1));
    assert_value(&defaults, "wot.refreshIntervalHours", number(24));
}

#[test]
fn nip56_defaults_are_disabled() {
    let defaults = defaults();
    assert_value(&defaults, "nip56.enabled", boolean(false));
    assert_value(&defaults, "nip56.trustedModerators", Value::Sequence(vec![]));
}

#[test]
fn a_nip43_user_block_overrides_the_defaults() {
    let defaults = defaults();
    let user: Value = serde_yaml::from_str(
        "nip43:\n  enabled: true\n  inviteCodeExpirySeconds: 86400\n  defaultMaxUses: 5\n",
    )
    .expect("user document parses");
    let merged = merge(&defaults, &user);
    assert_value(&merged, "nip43.enabled", boolean(true));
    assert_value(&merged, "nip43.inviteCodeExpirySeconds", number(86_400));
    assert_value(&merged, "nip43.defaultMaxUses", number(5));
}

#[test]
fn a_nip66_user_block_overrides_only_what_it_names() {
    let defaults = defaults();
    let user: Value = serde_yaml::from_str(
        "nip66:\n  enabled: true\n  probeIntervalSeconds: 900\n  targets:\n    - wss://relay.example.com\n",
    )
    .expect("user document parses");
    let merged = merge(&defaults, &user);
    assert_value(&merged, "nip66.enabled", boolean(true));
    assert_value(&merged, "nip66.probeIntervalSeconds", number(900));
    assert_value(
        &merged,
        "nip66.targets[0]",
        Value::String("wss://relay.example.com".to_owned()),
    );
    assert_value(&merged, "nip66.timeouts.dnsMs", number(10_000));
    assert_value(&merged, "nip66.dnsCacheTtlSeconds", number(300));
}

#[test]
fn a_wot_user_block_keeps_unmentioned_fields() {
    let defaults = defaults();
    let user: Value =
        serde_yaml::from_str("wot:\n  enabled: true\n  seedPubkey: abc123\n  minimumFollowers: 3\n")
            .expect("user document parses");
    let merged = merge(&defaults, &user);
    assert_value(&merged, "wot.enabled", boolean(true));
    assert_value(&merged, "wot.seedPubkey", Value::String("abc123".to_owned()));
    assert_value(&merged, "wot.minimumFollowers", number(3));
    assert_value(&merged, "wot.refreshIntervalHours", number(24));
}

#[test]
fn a_nip56_user_block_overrides_the_defaults() {
    let defaults = defaults();
    let user: Value = serde_yaml::from_str(
        "nip56:\n  enabled: true\n  trustedModerators:\n    - aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
    )
    .expect("user document parses");
    let merged = merge(&defaults, &user);
    assert_value(&merged, "nip56.enabled", boolean(true));
    assert_value(
        &merged,
        "nip56.trustedModerators[0]",
        Value::String("a".repeat(64)),
    );
}
