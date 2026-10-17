//! Redaction, ported from `test/unit/utils/settings-redaction.spec.ts`.

use nostream_config::path::get_by_path;
use nostream_config::redaction::{
    is_sensitive_settings_path, is_write_protected_settings_path, redact_settings_secrets,
    redact_settings_value,
};
use serde_yaml::Value;

fn document(raw: &str) -> Value {
    serde_yaml::from_str(raw).expect("document parses")
}

#[test]
fn redacts_password_hashes_and_nested_secrets() {
    let input = document(
        "admin:\n  enabled: true\n  passwordHash: hashed-password-value\nmirroring:\n  static:\n    - address: wss://mirror.example\n      secret: mirror-secret-value\npayments:\n  enabled: false\n",
    );
    let redacted = redact_settings_secrets(&input);

    let value = |path: &str| get_by_path(&redacted, path).expect("path").cloned();

    assert_eq!(
        value("admin.passwordHash"),
        Some(Value::String("***".to_owned()))
    );
    assert_eq!(
        value("mirroring.static[0].secret"),
        Some(Value::String("***".to_owned()))
    );
    assert_eq!(
        value("mirroring.static[0].address"),
        Some(Value::String("wss://mirror.example".to_owned()))
    );
    assert_eq!(value("payments.enabled"), Some(Value::Bool(false)));
}

#[test]
fn leaves_empty_secret_values_unchanged() {
    let input = document("mirroring:\n  static:\n    - address: wss://mirror.example\n      secret: ''\n");
    let redacted = redact_settings_secrets(&input);
    assert_eq!(
        get_by_path(&redacted, "mirroring.static[0].secret")
            .expect("path")
            .cloned(),
        Some(Value::String(String::new()))
    );
}

#[test]
fn identifies_sensitive_and_write_protected_paths() {
    assert!(is_sensitive_settings_path("admin.passwordHash"));
    assert!(is_sensitive_settings_path("mirroring.static[0].secret"));
    assert!(!is_sensitive_settings_path("payments.enabled"));
    assert!(is_write_protected_settings_path("admin.passwordHash"));
    assert!(!is_write_protected_settings_path("mirroring.static[0].secret"));
}

#[test]
fn redacts_single_values_by_path() {
    assert_eq!(
        redact_settings_value(
            "mirroring.static[0].secret",
            &Value::String("top-secret".to_owned())
        ),
        Value::String("***".to_owned())
    );
    assert_eq!(
        redact_settings_value("payments.enabled", &Value::Bool(true)),
        Value::Bool(true)
    );
    assert_eq!(
        redact_settings_value(
            "admin.notifications.targets[0].url",
            &Value::String("https://discord.com/api/webhooks/secret".to_owned())
        ),
        Value::String("***".to_owned())
    );
}

#[test]
fn redacts_notification_webhook_urls_in_nested_settings() {
    let input = document(
        "admin:\n  notifications:\n    targets:\n      - id: slack-ops\n        type: slack\n        enabled: true\n        url: https://hooks.slack.com/services/T00/B00/xxxxx\n",
    );
    let redacted = redact_settings_secrets(&input);
    assert_eq!(
        get_by_path(&redacted, "admin.notifications.targets[0].url")
            .expect("path")
            .cloned(),
        Some(Value::String("***".to_owned()))
    );
}

#[test]
fn a_non_secret_url_somewhere_else_is_left_alone() {
    assert!(!is_sensitive_settings_path("info.relay_url"));
    assert!(!is_sensitive_settings_path("mirroring.static[0].address"));
}
