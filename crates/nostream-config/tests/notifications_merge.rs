//! Admin-notification merge and patch semantics, ported from
//! `test/unit/utils/admin-notifications-settings.spec.ts`.

use nostream_config::notifications::{
    AdminNotificationsPatch, AdminNotificationsSettings, get_merged_admin_notifications,
    merge_admin_notifications_patch,
};

fn settings(raw: &str) -> AdminNotificationsSettings {
    serde_yaml::from_str(raw).expect("settings parse")
}

fn patch(raw: &str) -> AdminNotificationsPatch {
    serde_yaml::from_str(raw).expect("patch parses")
}

fn current_with_discord() -> AdminNotificationsSettings {
    settings(
        "enabled: true\ntargets:\n  - id: discord-1\n    type: discord\n    enabled: true\n    url: https://discord.com/api/webhooks/secret\nevents:\n  settings.changed: true\nretry:\n  maxAttempts: 5\n  baseDelayMs: 1000\n",
    )
}

#[test]
fn merges_patch_values_and_preserves_redacted_webhook_secrets() {
    let current = current_with_discord();
    let next = merge_admin_notifications_patch(
        &current,
        &patch(
            "targets:\n  - id: discord-1\n    type: discord\n    enabled: false\n    url: '***'\n",
        ),
    );

    assert_eq!(next.targets[0].enabled, Some(false));
    assert_eq!(
        next.targets[0].url.as_ref().map(|secret| secret.expose()),
        Some("https://discord.com/api/webhooks/secret")
    );
}

#[test]
fn does_not_persist_redacted_placeholders_for_new_targets() {
    let current = settings(
        "enabled: true\ntargets: []\nevents: {}\nretry:\n  maxAttempts: 5\n  baseDelayMs: 1000\n",
    );
    let next = merge_admin_notifications_patch(
        &current,
        &patch(
            "targets:\n  - id: telegram-new\n    type: telegram\n    enabled: true\n    botToken: '***'\n    chatId: '123'\n",
        ),
    );

    assert_eq!(next.targets[0].bot_token, None);
    assert_eq!(next.targets[0].chat_id.as_deref(), Some("123"));
}

#[test]
fn does_not_persist_a_redacted_url_for_new_http_targets() {
    let current = settings(
        "enabled: true\ntargets: []\nevents: {}\nretry:\n  maxAttempts: 5\n  baseDelayMs: 1000\n",
    );
    let next = merge_admin_notifications_patch(
        &current,
        &patch("targets:\n  - id: http-new\n    type: http\n    enabled: true\n    url: '***'\n"),
    );

    assert_eq!(next.targets[0].url, None);
}

#[test]
fn a_patch_merges_events_and_retry_and_replaces_scalars() {
    let current = current_with_discord();
    let next = merge_admin_notifications_patch(
        &current,
        &patch(
            "enabled: false\nevents:\n  relay.restarted: true\nretry:\n  maxAttempts: 9\ndeliveryLogRetentionDays: 7\n",
        ),
    );

    assert!(!next.enabled);
    assert_eq!(next.events.settings_changed, Some(true));
    assert_eq!(next.events.relay_restarted, Some(true));
    assert_eq!(next.retry.max_attempts, Some(9));
    assert_eq!(next.retry.base_delay_ms, Some(1000));
    assert_eq!(next.delivery_log_retention_days, Some(7));
    assert_eq!(
        next.targets.len(),
        1,
        "a patch without targets keeps the current ones"
    );
}

#[test]
fn a_patch_replaces_targets_wholesale() {
    let current = current_with_discord();
    let next = merge_admin_notifications_patch(
        &current,
        &patch(
            "targets:\n  - id: replacement\n    type: http\n    enabled: true\n    url: https://a.example/hook\n",
        ),
    );

    assert_eq!(next.targets.len(), 1);
    assert_eq!(next.targets[0].id, "replacement");
    assert_eq!(
        next.targets[0].url.as_ref().map(|secret| secret.expose()),
        Some("https://a.example/hook")
    );
}

#[test]
fn the_effective_block_falls_back_to_the_capture_defaults() {
    let merged = get_merged_admin_notifications(None, None);
    assert!(!merged.enabled);
    assert!(merged.targets.is_empty());
    assert_eq!(merged.retry.max_attempts, Some(5));
    assert_eq!(merged.retry.base_delay_ms, Some(1000));
    assert_eq!(merged.delivery_log_retention_days, Some(30));
    assert_eq!(merged.events, Default::default());
}

#[test]
fn configured_values_win_and_defaults_fill_the_gaps() {
    let defaults = settings(
        "enabled: false\ntargets: []\nevents:\n  settings.changed: true\n  relay.restarted: false\nretry:\n  maxAttempts: 3\n  baseDelayMs: 250\n",
    );
    let configured = settings(
        "enabled: true\ntargets:\n  - id: t\n    type: telegram\n    botToken: token\n    chatId: chat\nevents:\n  relay.restarted: true\nretry:\n  maxAttempts: 8\n",
    );
    let merged = get_merged_admin_notifications(Some(&configured), Some(&defaults));

    assert!(merged.enabled);
    assert_eq!(merged.retry.max_attempts, Some(8));
    assert_eq!(merged.retry.base_delay_ms, Some(250));
    assert_eq!(merged.events.settings_changed, Some(true));
    assert_eq!(merged.events.relay_restarted, Some(true));
    assert_eq!(merged.delivery_log_retention_days, Some(30));
}
