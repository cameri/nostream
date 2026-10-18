//! The guided settings catalogue, ported from the `settings-guided-schema` block of
//! `test/unit/utils/settings-config.spec.ts`.

// This integration-test target may unwrap: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use nostream_config::guided::{
    GuidedSettingFieldType, GuidedSettingValidator, get_guided_setting_category,
    get_guided_setting_field, guided_setting_categories, require_non_empty_setting_value,
    require_safe_non_negative_integer_setting_value,
};

#[test]
fn exports_guided_categories_for_admin_and_cli_use() {
    assert!(!guided_setting_categories().is_empty());
    let payments = get_guided_setting_category("payments").expect("payments category");
    assert!(
        payments
            .settings
            .iter()
            .any(|entry| entry.path == "payments.enabled")
    );
}

#[test]
fn looks_up_a_field_by_category_and_path() {
    let field =
        get_guided_setting_field("limits", "limits.rateLimiter.strategy").expect("strategy field");
    assert_eq!(field.field_type, GuidedSettingFieldType::Select);
    assert_eq!(field.options, vec!["ewma", "sliding_window"]);
}

#[test]
fn categories_and_paths_are_unique() {
    for category in guided_setting_categories() {
        let mut paths = category
            .settings
            .iter()
            .map(|field| field.path.as_str())
            .collect::<Vec<_>>();
        paths.sort_unstable();
        let unique = {
            let mut paths = paths.clone();
            paths.dedup();
            paths
        };
        assert_eq!(paths, unique, "duplicate field path in {}", category.value);
        assert!(!category.settings.is_empty(), "{} is empty", category.value);
    }
}

#[test]
fn validates_guided_numeric_fields() {
    assert_eq!(
        require_safe_non_negative_integer_setting_value("bad"),
        Some("Value must be a non-negative integer")
    );
    assert_eq!(
        require_safe_non_negative_integer_setting_value("2048"),
        None
    );
    assert_eq!(
        require_safe_non_negative_integer_setting_value("9007199254740992"),
        Some("Value must be a safe integer")
    );
    assert_eq!(
        require_non_empty_setting_value(" "),
        Some("Value is required")
    );
    assert_eq!(require_non_empty_setting_value("relay.example.com"), None);
}

#[test]
fn validators_are_reachable_from_the_field() {
    let field = get_guided_setting_field("network", "network.maxPayloadSize")
        .expect("maxPayloadSize field");
    let validator = field.validate.expect("the field validates");
    assert_eq!(
        validator.validate("-1"),
        Some("Value must be a non-negative integer")
    );
    assert_eq!(validator.validate("524288"), None);
    assert_eq!(
        GuidedSettingValidator::NonEmpty.validate("  "),
        Some("Value is required")
    );
}

#[test]
fn deferred_nip77_surface_is_not_modelled() {
    assert!(get_guided_setting_category("nip77").is_none());
    assert!(guided_setting_categories().iter().all(|category| {
        category
            .settings
            .iter()
            .all(|field| !field.path.starts_with("nip77"))
    }));
}
