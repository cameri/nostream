//! Redaction, ported from `test/unit/utils/settings-redaction.spec.ts`.

// This integration-test target may unwrap: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used)]

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
    let input =
        document("mirroring:\n  static:\n    - address: wss://mirror.example\n      secret: ''\n");
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
    assert!(!is_write_protected_settings_path(
        "mirroring.static[0].secret"
    ));
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

#[test]
fn the_subtree_root_still_redacts_webhook_urls() {
    // Regression for round 3 item 4: every earlier redaction test rooted the walk at the
    // full settings document, so paths carried `admin.notifications.`; the admin
    // notifications getter roots it at the notifications subtree, and the bare-subtree
    // serialization produced `targets[0].url`, which the `url` rule did not match —
    // while botToken (a sensitive key anywhere) redacted, hiding the gap.
    use nostream_config::notifications::{
        AdminNotificationsSettings, OperatorNotificationChannelType,
        OperatorNotificationEventToggles, OperatorNotificationRetrySettings,
        OperatorNotificationTarget, get_redacted_admin_notifications,
    };

    let settings = AdminNotificationsSettings {
        enabled: true,
        targets: vec![OperatorNotificationTarget {
            id: "t1".to_owned(),
            target_type: OperatorNotificationChannelType::Discord,
            enabled: Some(true),
            url: Some(nostream_core::Secret(
                "https://discord.com/api/webhooks/token-value".to_owned(),
            )),
            bot_token: Some(nostream_core::Secret("bot-token-value".to_owned())),
            chat_id: None,
        }],
        events: OperatorNotificationEventToggles::default(),
        retry: OperatorNotificationRetrySettings::default(),
        delivery_log_retention_days: None,
    };

    let redacted = get_redacted_admin_notifications(&settings, None).expect("redacts");
    let url = redacted.targets[0]
        .url
        .as_ref()
        .map(|secret| secret.expose());
    let bot = redacted.targets[0]
        .bot_token
        .as_ref()
        .map(|secret| secret.expose());
    assert_eq!(url, Some("***"), "the webhook url must redact");
    assert_eq!(bot, Some("***"));
    assert!(!format!("{redacted:?}").contains("token-value"));
}
