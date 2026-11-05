//! `operator-notification-service.ts`: the dispatcher that merges the configured notification
//! block over the shipped defaults, builds one envelope and delivers it to every target that
//! has not already received this outbox message.

use std::pin::Pin;
use std::sync::Arc;

use chrono::{SecondsFormat, TimeZone, Utc};
use nostream_config::Settings;
use nostream_config::notifications::{
    AdminNotificationsSettings, OperatorNotificationEventToggles, get_merged_admin_notifications,
};
use nostream_core::clock::Clock;
use nostream_storage::repositories::{
    NewDeliveryLogEntry, NotificationDeliveryLogRepository, NotificationDeliveryStatus,
    NotificationTargetType,
};
use serde_json::Value;

use crate::error::ServicesError;
use crate::http::HttpClient;
use crate::services::notification_channels::{
    NotificationEnvelope, deliver_to_target, mask_target_for_log,
};

/// What one dispatch knows about the outbox row it serves (`OperatorNotificationDispatchContext`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DispatchContext {
    pub outbox_id: Option<String>,
    pub attempt_number: i32,
}

impl DispatchContext {
    /// A dispatch outside the outbox walk: no row, first attempt.
    pub fn new() -> Self {
        Self {
            outbox_id: None,
            attempt_number: 1,
        }
    }
}

/// The dispatcher the outbox walk calls.
pub trait NotificationDispatcher: Send + Sync {
    fn dispatch<'a>(
        &'a self,
        event_type: &'a str,
        payload: &'a Value,
        context: &'a DispatchContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + 'a>>;
}

/// `OperatorNotificationService`.
pub struct OperatorNotificationService {
    settings: Arc<Settings>,
    defaults: Option<Arc<AdminNotificationsSettings>>,
    delivery_log: Arc<dyn NotificationDeliveryLogRepository>,
    http: Arc<dyn HttpClient>,
    clock: Arc<dyn Clock>,
}

impl OperatorNotificationService {
    /// Builds the dispatcher. `defaults` is the shipped document's `admin.notifications`
    /// block, which the daemon loads; a caller that already holds a merged settings tree can
    /// pass `None`.
    pub fn new(
        settings: Arc<Settings>,
        defaults: Option<Arc<AdminNotificationsSettings>>,
        delivery_log: Arc<dyn NotificationDeliveryLogRepository>,
        http: Arc<dyn HttpClient>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            settings,
            defaults,
            delivery_log,
            http,
            clock,
        }
    }

    /// The effective notification block.
    pub fn merged(&self) -> AdminNotificationsSettings {
        get_merged_admin_notifications(
            self.settings
                .admin
                .as_ref()
                .and_then(|admin| admin.notifications.as_ref()),
            self.defaults.as_deref(),
        )
    }

    /// `getMaxAttempts`.
    pub fn max_attempts(&self) -> i32 {
        self.merged()
            .retry
            .max_attempts
            .unwrap_or(5)
            .min(i32::MAX as u32) as i32
    }

    /// `getBaseDelayMs`.
    pub fn base_delay_ms(&self) -> i64 {
        self.merged()
            .retry
            .base_delay_ms
            .unwrap_or(1_000)
            .min(i64::MAX as u64) as i64
    }

    fn envelope(&self, event_type: &str, payload: &Value) -> NotificationEnvelope {
        let millis = i64::try_from(self.clock.now_ms()).unwrap_or(i64::MAX);
        let timestamp = Utc
            .timestamp_millis_opt(millis)
            .single()
            .unwrap_or(chrono::DateTime::UNIX_EPOCH)
            .to_rfc3339_opts(SecondsFormat::Millis, true);

        NotificationEnvelope {
            event: event_type.to_owned(),
            relay: self.settings.info.relay_url.clone(),
            timestamp,
            data: payload.clone(),
        }
    }

    async fn append_delivery_log(&self, entry: NewDeliveryLogEntry) {
        if let Err(error) = self.delivery_log.append(&entry).await {
            tracing::error!(
                target_id = entry.target_id,
                status = ?entry.status,
                error = %error,
                "delivery log append failed"
            );
        }
    }
}

/// `isEventEnabled`: an event is enabled unless its toggle is exactly `false`.
pub fn is_event_enabled(events: &OperatorNotificationEventToggles, event_type: &str) -> bool {
    let toggle = match event_type {
        "admission.invoice.created" => events.admission_invoice_created,
        "admission.invoice.paid" => events.admission_invoice_paid,
        "admission.invoice.failed" => events.admission_invoice_failed,
        "settings.changed" => events.settings_changed,
        "relay.restarted" => events.relay_restarted,
        "probe.failed" => events.probe_failed,
        "probe.recovered" => events.probe_recovered,
        "ssl.expiring" => events.ssl_expiring,
        _ => None,
    };

    toggle != Some(false)
}

impl NotificationDispatcher for OperatorNotificationService {
    fn dispatch<'a>(
        &'a self,
        event_type: &'a str,
        payload: &'a Value,
        context: &'a DispatchContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + 'a>> {
        Box::pin(async move {
            let config = self.merged();

            if !config.enabled {
                return Ok(());
            }

            if !is_event_enabled(&config.events, event_type) {
                return Ok(());
            }

            let enabled_targets: Vec<_> = config
                .targets
                .iter()
                .filter(|target| target.enabled == Some(true))
                .collect();

            if enabled_targets.is_empty() {
                return Ok(());
            }

            let already_delivered = match context.outbox_id.as_deref() {
                Some(outbox_id) => self
                    .delivery_log
                    .find_successful_target_ids(outbox_id)
                    .await
                    .unwrap_or_default(),
                None => Vec::new(),
            };

            let targets: Vec<_> = enabled_targets
                .into_iter()
                .filter(|target| !already_delivered.contains(&target.id))
                .collect();

            if targets.is_empty() {
                return Ok(());
            }

            let envelope = self.envelope(event_type, payload);
            let attempt_number = if context.attempt_number > 0 {
                context.attempt_number
            } else {
                1
            };
            let mut failures = Vec::new();

            for target in targets {
                match deliver_to_target(target, &envelope, self.http.as_ref()).await {
                    Ok(()) => {
                        self.append_delivery_log(NewDeliveryLogEntry {
                            outbox_id: context.outbox_id.clone(),
                            event_type: event_type.to_owned(),
                            target_id: target.id.clone(),
                            target_type: target_type(target.target_type),
                            status: NotificationDeliveryStatus::Success,
                            attempt_number,
                            error_snippet: None,
                        })
                        .await;
                    }
                    Err(error) => {
                        let message = error.to_string();
                        tracing::error!(
                            target = mask_target_for_log(target),
                            error = %message,
                            "delivery failed"
                        );
                        failures.push(format!("{}: {message}", target.id));
                        self.append_delivery_log(NewDeliveryLogEntry {
                            outbox_id: context.outbox_id.clone(),
                            event_type: event_type.to_owned(),
                            target_id: target.id.clone(),
                            target_type: target_type(target.target_type),
                            status: NotificationDeliveryStatus::Failed,
                            attempt_number,
                            error_snippet: Some(message),
                        })
                        .await;
                    }
                }
            }

            if failures.is_empty() {
                Ok(())
            } else {
                Err(ServicesError::Notification(failures.join("; ")))
            }
        })
    }
}

fn target_type(
    target_type: nostream_config::notifications::OperatorNotificationChannelType,
) -> NotificationTargetType {
    match target_type {
        nostream_config::notifications::OperatorNotificationChannelType::Http => {
            NotificationTargetType::Http
        }
        nostream_config::notifications::OperatorNotificationChannelType::Discord => {
            NotificationTargetType::Discord
        }
        nostream_config::notifications::OperatorNotificationChannelType::Slack => {
            NotificationTargetType::Slack
        }
        nostream_config::notifications::OperatorNotificationChannelType::Telegram => {
            NotificationTargetType::Telegram
        }
    }
}
