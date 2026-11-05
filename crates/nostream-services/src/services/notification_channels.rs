//! The four operator-notification channels (`notification-channels.ts`).
//!
//! Every request carries the capture's 15-second timeout and only a 2xx status is success.
//! The HTTP channel signs the body with the target's secret; the other three wrap the data
//! in their own payload shape with their own truncation limit.

use std::time::Duration;

use nostream_config::notifications::OperatorNotificationTarget;
use serde_json::Value;

use crate::error::ServicesError;
use crate::http::HttpClient;
use crate::payments::hmac_sha256;

/// Every channel request's timeout (`REQUEST_TIMEOUT_MS`,
/// `src/services/notification-channels.ts:10`).
pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(15_000);

/// The Discord body's data cap (`src/services/notification-channels.ts:57`).
pub const DISCORD_DATA_LIMIT: usize = 1_800;

/// The Slack mrkdwn block's data cap (`src/services/notification-channels.ts:83`).
pub const SLACK_DATA_LIMIT: usize = 2_800;

/// The Telegram message's data cap (`src/services/notification-channels.ts:103`).
pub const TELEGRAM_DATA_LIMIT: usize = 3_500;

/// The JSON document every channel receives (`OperatorNotificationEnvelope`).
#[derive(Debug, Clone, PartialEq)]
pub struct NotificationEnvelope {
    pub event: String,
    pub relay: String,
    pub timestamp: String,
    pub data: Value,
}

impl NotificationEnvelope {
    /// The envelope as the HTTP channel sends it.
    pub fn to_body(&self) -> Result<String, ServicesError> {
        serde_json::to_string(&serde_json::json!({
            "event": self.event,
            "relay": self.relay,
            "timestamp": self.timestamp,
            "data": self.data,
        }))
        .map_err(|error| ServicesError::Notification(error.to_string()))
    }

    /// The headline every channel puts first: `[<event>] <relay>`.
    fn headline(&self) -> String {
        format!("[{}] {}", self.event, self.relay)
    }
}

/// Truncates to `limit` characters at a character boundary.
fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// `deliverToTarget` (`src/services/notification-channels.ts:12-118`).
pub async fn deliver_to_target(
    target: &OperatorNotificationTarget,
    envelope: &NotificationEnvelope,
    http: &dyn HttpClient,
) -> Result<(), ServicesError> {
    match target.target_type {
        nostream_config::notifications::OperatorNotificationChannelType::Http => {
            deliver_http(target, envelope, http).await
        }
        nostream_config::notifications::OperatorNotificationChannelType::Discord => {
            deliver_discord(target, envelope, http).await
        }
        nostream_config::notifications::OperatorNotificationChannelType::Slack => {
            deliver_slack(target, envelope, http).await
        }
        nostream_config::notifications::OperatorNotificationChannelType::Telegram => {
            deliver_telegram(target, envelope, http).await
        }
    }
}

async fn deliver_http(
    target: &OperatorNotificationTarget,
    envelope: &NotificationEnvelope,
    http: &dyn HttpClient,
) -> Result<(), ServicesError> {
    let url = target.url.as_ref().ok_or_else(|| {
        ServicesError::Notification("HTTP notification target requires url".to_owned())
    })?;
    let body = envelope.to_body()?;
    let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];

    if let Some(secret) = target.secret.as_ref() {
        let digest = hex::encode(hmac_sha256(secret.expose().as_bytes(), body.as_bytes())?);
        headers.push((
            "x-nostream-signature".to_owned(),
            format!("sha256={digest}"),
        ));
    }

    http.post(url.expose(), &headers, &body, REQUEST_TIMEOUT)
        .await
        .map(|_| ())
}

async fn deliver_discord(
    target: &OperatorNotificationTarget,
    envelope: &NotificationEnvelope,
    http: &dyn HttpClient,
) -> Result<(), ServicesError> {
    let url = target.url.as_ref().ok_or_else(|| {
        ServicesError::Notification("Discord notification target requires webhook url".to_owned())
    })?;
    let data = serde_json::to_string_pretty(&envelope.data).unwrap_or_default();
    let content = format!(
        "{}\n```json\n{}\n```",
        envelope.headline(),
        truncate(&data, DISCORD_DATA_LIMIT)
    );
    let body = serde_json::json!({ "content": content });

    post_json(http, url.expose(), &body).await
}

async fn deliver_slack(
    target: &OperatorNotificationTarget,
    envelope: &NotificationEnvelope,
    http: &dyn HttpClient,
) -> Result<(), ServicesError> {
    let url = target.url.as_ref().ok_or_else(|| {
        ServicesError::Notification("Slack notification target requires webhook url".to_owned())
    })?;
    let data = serde_json::to_string(&envelope.data).unwrap_or_default();
    let mrkdwn = format!(
        "*{}* on `{}`\n```{}```",
        envelope.event,
        envelope.relay,
        truncate(&data, SLACK_DATA_LIMIT)
    );
    let body = serde_json::json!({
        "text": envelope.headline(),
        "blocks": [{
            "type": "section",
            "text": { "type": "mrkdwn", "text": mrkdwn },
        }],
    });

    post_json(http, url.expose(), &body).await
}

async fn deliver_telegram(
    target: &OperatorNotificationTarget,
    envelope: &NotificationEnvelope,
    http: &dyn HttpClient,
) -> Result<(), ServicesError> {
    let (Some(bot_token), Some(chat_id)) = (target.bot_token.as_ref(), target.chat_id.as_ref())
    else {
        return Err(ServicesError::Notification(
            "Telegram notification target requires botToken and chatId".to_owned(),
        ));
    };
    let data = serde_json::to_string(&envelope.data).unwrap_or_default();
    let text = format!(
        "{}\n{}",
        envelope.headline(),
        truncate(&data, TELEGRAM_DATA_LIMIT)
    );
    let url = format!(
        "https://api.telegram.org/bot{}/sendMessage",
        bot_token.expose()
    );
    let body = serde_json::json!({
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": true,
    });

    post_json(http, &url, &body).await
}

async fn post_json(http: &dyn HttpClient, url: &str, body: &Value) -> Result<(), ServicesError> {
    crate::http::post_json(http, url, body, REQUEST_TIMEOUT)
        .await
        .map(|_| ())
}

/// `maskTargetForLog`: what a failure line names without leaking the webhook.
pub fn mask_target_for_log(target: &OperatorNotificationTarget) -> String {
    format!("{:?}:{}", target.target_type, target.id)
}

/// `validateTargetConfig`: the admin API's own validation, which this job's channels mirror.
pub fn validate_target_config(target: &OperatorNotificationTarget) -> Option<String> {
    if target.id.trim().is_empty() {
        return Some("target id is required".to_owned());
    }

    let missing_url = target
        .url
        .as_ref()
        .is_none_or(|url| url.expose().trim().is_empty());

    match target.target_type {
        nostream_config::notifications::OperatorNotificationChannelType::Http => {
            if missing_url {
                return Some("http target requires url".to_owned());
            }
        }
        nostream_config::notifications::OperatorNotificationChannelType::Discord => {
            if missing_url {
                return Some("discord target requires url".to_owned());
            }
        }
        nostream_config::notifications::OperatorNotificationChannelType::Slack => {
            if missing_url {
                return Some("slack target requires url".to_owned());
            }
        }
        nostream_config::notifications::OperatorNotificationChannelType::Telegram => {
            let has_token = target
                .bot_token
                .as_ref()
                .is_some_and(|token| !token.expose().trim().is_empty());
            let has_chat = target
                .chat_id
                .as_ref()
                .is_some_and(|chat| !chat.trim().is_empty());

            if !has_token || !has_chat {
                return Some("telegram target requires botToken and chatId".to_owned());
            }
        }
    }

    None
}
