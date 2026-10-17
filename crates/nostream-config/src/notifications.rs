//! Admin notification settings. Mirrors `src/utils/admin-notifications-settings.ts` and
//! `src/@types/operator-notifications.ts`.

use serde::{Deserialize, Serialize};

use crate::redaction::redact_settings_secrets;

/// The placeholder the admin UI sends back instead of a secret it was shown.
pub const REDACTED_SECRET: &str = "***";

/// A notification channel (`OperatorNotificationChannelType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperatorNotificationChannelType {
    Http,
    Discord,
    Slack,
    Telegram,
}

/// One notification target (`OperatorNotificationTarget`).
///
/// `enabled` is optional here although the TypeScript type requires it: the validator treats
/// it as optional, and a typed parse that disagrees with the validator would turn a valid
/// document into a fallback-to-defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorNotificationTarget {
    pub id: String,
    #[serde(rename = "type")]
    pub target_type: OperatorNotificationChannelType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Typed `Secret` (the webhook URL embeds a token); see `Secret`'s doc comment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<nostream_core::Secret>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_token: Option<nostream_core::Secret>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
}

/// The per-event toggles (`OperatorNotificationEventToggles`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperatorNotificationEventToggles {
    #[serde(
        rename = "admission.invoice.created",
        skip_serializing_if = "Option::is_none"
    )]
    pub admission_invoice_created: Option<bool>,
    #[serde(
        rename = "admission.invoice.paid",
        skip_serializing_if = "Option::is_none"
    )]
    pub admission_invoice_paid: Option<bool>,
    #[serde(
        rename = "admission.invoice.failed",
        skip_serializing_if = "Option::is_none"
    )]
    pub admission_invoice_failed: Option<bool>,
    #[serde(rename = "settings.changed", skip_serializing_if = "Option::is_none")]
    pub settings_changed: Option<bool>,
    #[serde(rename = "relay.restarted", skip_serializing_if = "Option::is_none")]
    pub relay_restarted: Option<bool>,
}

/// Retry policy (`OperatorNotificationRetrySettings`).
///
/// Both fields are optional: the capture's merge reads each with `??`, and a user block that
/// names only one keeps the other from the defaults.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorNotificationRetrySettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_delay_ms: Option<u64>,
}

/// `admin.notifications` (`AdminNotificationsSettings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminNotificationsSettings {
    pub enabled: bool,
    pub targets: Vec<OperatorNotificationTarget>,
    pub events: OperatorNotificationEventToggles,
    pub retry: OperatorNotificationRetrySettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_log_retention_days: Option<i64>,
}

/// A target in an incoming patch: every field the admin UI may send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationTargetPatch {
    pub id: String,
    #[serde(rename = "type")]
    pub target_type: OperatorNotificationChannelType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Typed `Secret` (the webhook URL embeds a token); see `Secret`'s doc comment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<nostream_core::Secret>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_token: Option<nostream_core::Secret>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
}

/// Retry fields in an incoming patch.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRetryPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_delay_ms: Option<u64>,
}

/// An incoming admin patch (`Partial<AdminNotificationsSettings>`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminNotificationsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub targets: Option<Vec<NotificationTargetPatch>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<OperatorNotificationEventToggles>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<NotificationRetryPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_log_retention_days: Option<i64>,
}

fn merge_events(
    defaults: Option<&OperatorNotificationEventToggles>,
    configured: Option<&OperatorNotificationEventToggles>,
) -> OperatorNotificationEventToggles {
    let defaults = defaults.cloned().unwrap_or_default();
    let Some(configured) = configured else {
        return defaults;
    };
    OperatorNotificationEventToggles {
        admission_invoice_created: configured
            .admission_invoice_created
            .or(defaults.admission_invoice_created),
        admission_invoice_paid: configured
            .admission_invoice_paid
            .or(defaults.admission_invoice_paid),
        admission_invoice_failed: configured
            .admission_invoice_failed
            .or(defaults.admission_invoice_failed),
        settings_changed: configured.settings_changed.or(defaults.settings_changed),
        relay_restarted: configured.relay_restarted.or(defaults.relay_restarted),
    }
}

/// The effective notifications block: configured values over defaults, with the capture's
/// numeric fallbacks (5 attempts, 1000 ms, 30 days).
pub fn get_merged_admin_notifications(
    configured: Option<&AdminNotificationsSettings>,
    defaults: Option<&AdminNotificationsSettings>,
) -> AdminNotificationsSettings {
    AdminNotificationsSettings {
        enabled: configured
            .map(|settings| settings.enabled)
            .or_else(|| defaults.map(|settings| settings.enabled))
            .unwrap_or(false),
        targets: configured
            .map(|settings| settings.targets.clone())
            .or_else(|| defaults.map(|settings| settings.targets.clone()))
            .unwrap_or_default(),
        events: merge_events(
            defaults.map(|settings| &settings.events),
            configured.map(|settings| &settings.events),
        ),
        retry: OperatorNotificationRetrySettings {
            max_attempts: configured
                .and_then(|settings| settings.retry.max_attempts)
                .or_else(|| defaults.and_then(|settings| settings.retry.max_attempts))
                .or(Some(5)),
            base_delay_ms: configured
                .and_then(|settings| settings.retry.base_delay_ms)
                .or_else(|| defaults.and_then(|settings| settings.retry.base_delay_ms))
                .or(Some(1000)),
        },
        delivery_log_retention_days: configured
            .and_then(|settings| settings.delivery_log_retention_days)
            .or_else(|| defaults.and_then(|settings| settings.delivery_log_retention_days))
            .or(Some(30)),
    }
}

/// The merged block with secrets replaced by `***`, for the admin UI.
pub fn get_redacted_admin_notifications(
    merged: &AdminNotificationsSettings,
    defaults: Option<&AdminNotificationsSettings>,
) -> Result<AdminNotificationsSettings, crate::ConfigError> {
    let document = serde_yaml::to_value(merged)?;
    let redacted = redact_settings_secrets(&document);
    let settings: AdminNotificationsSettings = serde_yaml::from_value(redacted)?;
    Ok(get_merged_admin_notifications(Some(&settings), defaults))
}

fn is_redacted_secret(value: Option<&str>) -> bool {
    value == Some(REDACTED_SECRET)
}

fn merge_target_secrets(
    incoming: &NotificationTargetPatch,
    existing: Option<&OperatorNotificationTarget>,
) -> OperatorNotificationTarget {
    let mut merged = OperatorNotificationTarget {
        id: incoming.id.clone(),
        target_type: incoming.target_type,
        enabled: Some(
            incoming
                .enabled
                .or(existing.and_then(|target| target.enabled))
                .unwrap_or(false),
        ),
        url: incoming.url.clone(),
        bot_token: incoming.bot_token.clone(),
        chat_id: incoming
            .chat_id
            .clone()
            .or_else(|| existing.and_then(|target| target.chat_id.clone())),
    };

    if is_redacted_secret(incoming.url.as_ref().map(|secret| secret.expose())) {
        merged.url = existing.and_then(|target| target.url.clone());
    } else if incoming.url.is_none() && existing.and_then(|target| target.url.clone()).is_some() {
        merged.url = existing.and_then(|target| target.url.clone());
    }

    if is_redacted_secret(incoming.bot_token.as_ref().map(|secret| secret.expose())) {
        merged.bot_token = existing.and_then(|target| target.bot_token.clone());
    } else if incoming.bot_token.is_none()
        && existing
            .and_then(|target| target.bot_token.clone())
            .is_some()
    {
        merged.bot_token = existing.and_then(|target| target.bot_token.clone());
    }

    merged
}

/// Applies an admin patch: scalars replace, events and retry merge, targets replace wholesale
/// while a redacted placeholder inherits the stored secret.
pub fn merge_admin_notifications_patch(
    current: &AdminNotificationsSettings,
    patch: &AdminNotificationsPatch,
) -> AdminNotificationsSettings {
    let events = merge_events(Some(&current.events), patch.events.as_ref());
    let retry = OperatorNotificationRetrySettings {
        max_attempts: patch
            .retry
            .as_ref()
            .and_then(|retry| retry.max_attempts)
            .or(current.retry.max_attempts),
        base_delay_ms: patch
            .retry
            .as_ref()
            .and_then(|retry| retry.base_delay_ms)
            .or(current.retry.base_delay_ms),
    };

    let targets = match &patch.targets {
        Some(incoming) => incoming
            .iter()
            .map(|target| {
                let existing = current.targets.iter().find(|entry| entry.id == target.id);
                merge_target_secrets(target, existing)
            })
            .collect(),
        None => current.targets.clone(),
    };

    AdminNotificationsSettings {
        enabled: patch.enabled.unwrap_or(current.enabled),
        targets,
        events,
        retry,
        delivery_log_retention_days: patch
            .delivery_log_retention_days
            .or(current.delivery_log_retention_days),
    }
}
