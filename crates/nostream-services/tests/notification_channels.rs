//! The four notification channels: payload shape, truncation, signing and status handling.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use nostream_config::notifications::OperatorNotificationChannelType;
use nostream_core::Secret;
use nostream_services::error::ServicesError;
use nostream_services::services::notification_channels::{
    DISCORD_DATA_LIMIT, NotificationEnvelope, REQUEST_TIMEOUT, SLACK_DATA_LIMIT,
    TELEGRAM_DATA_LIMIT, deliver_to_target, validate_target_config,
};
use nostream_services::testing;

fn sign(secret: &[u8], body: &[u8]) -> String {
    use hmac::{Mac, digest::KeyInit};
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(secret).expect("a key");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

fn envelope() -> NotificationEnvelope {
    NotificationEnvelope {
        event: "admission.invoice.created".to_owned(),
        relay: "wss://relay.example.com".to_owned(),
        timestamp: "2026-01-02T03:04:05Z".to_owned(),
        data: serde_json::json!({ "invoiceId": "invoice-1" }),
    }
}

#[tokio::test]
async fn the_http_channel_sends_the_envelope_and_signs_it_with_the_secret() {
    let http = testing::RecordingHttpClient::new();
    let mut target = testing::target(
        "ops",
        OperatorNotificationChannelType::Http,
        Some("https://relay.example.com/notify"),
    );
    target.secret = Some(Secret("super-secret".to_owned()));
    http.respond(204, "");

    deliver_to_target(&target, &envelope(), &*http)
        .await
        .expect("delivered");

    let call = http.last_call().expect("a call");
    assert_eq!(call.method, "POST");
    assert_eq!(call.url, "https://relay.example.com/notify");
    assert_eq!(call.timeout, REQUEST_TIMEOUT);
    assert_eq!(
        call.headers,
        vec![
            ("content-type".to_owned(), "application/json".to_owned()),
            (
                "x-nostream-signature".to_owned(),
                format!(
                    "sha256={}",
                    sign(b"super-secret", call.body.as_deref().unwrap_or_default().as_bytes())
                ),
            ),
        ]
    );
    let body: serde_json::Value =
        serde_json::from_str(call.body.as_deref().expect("a body")).expect("json");
    assert_eq!(body["event"], serde_json::json!("admission.invoice.created"));
    assert_eq!(body["relay"], serde_json::json!("wss://relay.example.com"));
    assert_eq!(body["timestamp"], serde_json::json!("2026-01-02T03:04:05Z"));
    assert_eq!(body["data"], serde_json::json!({ "invoiceId": "invoice-1" }));

    // Without a secret the signature header is absent.
    http.respond(204, "");
    let unsigned = testing::target(
        "ops",
        OperatorNotificationChannelType::Http,
        Some("https://relay.example.com/notify"),
    );
    deliver_to_target(&unsigned, &envelope(), &*http)
        .await
        .expect("delivered");
    let call = http.last_call().expect("a call");
    assert_eq!(
        call.headers,
        vec![("content-type".to_owned(), "application/json".to_owned())]
    );
}

#[tokio::test]
async fn discord_slack_and_telegram_wrap_the_envelope_and_truncate_the_data() {
    let long = serde_json::json!({ "key": "x".repeat(4_000) });
    let envelope = NotificationEnvelope {
        event: "relay.restarted".to_owned(),
        relay: "wss://relay.example.com".to_owned(),
        timestamp: "2026-01-02T03:04:05Z".to_owned(),
        data: long,
    };
    let http = testing::RecordingHttpClient::new();

    for (target_type, url) in [
        (
            OperatorNotificationChannelType::Discord,
            "https://discord.example.com/hook",
        ),
        (
            OperatorNotificationChannelType::Slack,
            "https://hooks.slack.example.com/T/B/X",
        ),
    ] {
        http.respond(204, "");
        let target = testing::target("chat", target_type, Some(url));
        deliver_to_target(&target, &envelope, &*http)
            .await
            .expect("delivered");
        let call = http.last_call().expect("a call");
        assert_eq!(call.url, url);
        assert_eq!(call.timeout, REQUEST_TIMEOUT);
    }

    let discord = http.calls().remove(0);
    let body: serde_json::Value =
        serde_json::from_str(discord.body.as_deref().expect("a body")).expect("json");
    let content = body["content"].as_str().expect("content");
    assert!(content.contains("[relay.restarted] wss://relay.example.com"));
    let data = content
        .split_once("```json\n")
        .expect("a fenced block")
        .1
        .strip_suffix("\n```")
        .expect("a closing fence");
    assert_eq!(data.chars().count(), DISCORD_DATA_LIMIT);
    assert!(data.starts_with("{\n  \"key\": \"xxx"));

    let slack = http.last_call().expect("a call");
    let body: serde_json::Value =
        serde_json::from_str(slack.body.as_deref().expect("a body")).expect("json");
    assert_eq!(
        body["text"],
        serde_json::json!("[relay.restarted] wss://relay.example.com")
    );
    let mrkdwn = body["blocks"][0]["text"]["text"].as_str().expect("mrkdwn");
    assert!(mrkdwn.contains("*relay.restarted*"));
    let data = mrkdwn
        .split_once("```")
        .expect("a fenced block")
        .1
        .strip_suffix("```")
        .expect("a closing fence");
    assert_eq!(data.chars().count(), SLACK_DATA_LIMIT);

    let http = testing::RecordingHttpClient::new();
    http.respond(204, "");
    let mut telegram = testing::target(
        "telegram",
        OperatorNotificationChannelType::Telegram,
        None,
    );
    telegram.bot_token = Some(Secret("123:abc".to_owned()));
    telegram.chat_id = Some("7175022".to_owned());
    deliver_to_target(&telegram, &envelope, &*http)
        .await
        .expect("delivered");
    let call = http.last_call().expect("a call");
    assert_eq!(call.url, "https://api.telegram.org/bot123:abc/sendMessage");
    let body: serde_json::Value =
        serde_json::from_str(call.body.as_deref().expect("a body")).expect("json");
    assert_eq!(body["chat_id"], serde_json::json!("7175022"));
    assert_eq!(body["disable_web_page_preview"], serde_json::json!(true));
    let text = body["text"].as_str().expect("text");
    let data = text
        .split_once("[relay.restarted] wss://relay.example.com\n")
        .expect("a headline")
        .1;
    assert_eq!(data.chars().count(), TELEGRAM_DATA_LIMIT);
    assert_eq!(call.timeout, REQUEST_TIMEOUT);
}

#[tokio::test]
async fn only_a_two_hundred_class_status_succeeds() {
    for (status, expected_ok) in [(204u16, true), (200, true), (300, false), (500, false)] {
        let http = testing::RecordingHttpClient::new();
        http.respond(status, "");
        let target = testing::target(
            "ops",
            OperatorNotificationChannelType::Http,
            Some("https://relay.example.com/notify"),
        );

        let result = deliver_to_target(&target, &envelope(), &*http).await;
        assert_eq!(result.is_ok(), expected_ok, "status {status}");
        if let Err(ServicesError::Http { status: Some(reported), .. }) = result {
            assert_eq!(reported, status);
        }
    }
}

#[test]
fn target_config_validation_mirrors_the_admin_api_and_masks_the_log() {
    let mut missing = testing::target("ops", OperatorNotificationChannelType::Http, None);
    assert_eq!(
        validate_target_config(&missing).as_deref(),
        Some("http target requires url")
    );
    missing.id = "  ".to_owned();
    assert_eq!(
        validate_target_config(&missing).as_deref(),
        Some("target id is required")
    );

    let telegram = testing::target("tg", OperatorNotificationChannelType::Telegram, None);
    assert_eq!(
        validate_target_config(&telegram).as_deref(),
        Some("telegram target requires botToken and chatId")
    );

    let ok = testing::target(
        "ops",
        OperatorNotificationChannelType::Slack,
        Some("https://hooks.slack.example.com/T/B/X"),
    );
    assert_eq!(validate_target_config(&ok), None);
    assert_eq!(
        nostream_services::services::notification_channels::mask_target_for_log(&ok),
        "Slack:ops"
    );
    assert_eq!(DISCORD_DATA_LIMIT, 1_800);
}
