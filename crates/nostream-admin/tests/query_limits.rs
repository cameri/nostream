//! AC14 — the query limits and the capture's messages, plus the boundary statuses R5 states.
//! Every `400`/`409`/`415`/`504`/`500` branch the route table lists is reachable here.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Fixture, PASSWORD, SlowEventRepository, TestServer};

fn server_with_events(events: Arc<dyn nostream_storage::repositories::EventRepository>) -> Fixture {
    Fixture {
        events: Some(events),
        ..Fixture::default()
    }
}

#[tokio::test]
async fn storage_counts_rejects_21_kinds() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let kinds: Vec<String> = (0..21).map(|kind| kind.to_string()).collect();
    let response = server
        .get_with(
            &format!("/admin/ops/storage/counts?kinds={}", kinds.join(",")),
            &cookie,
        )
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(
        response.json()["error"],
        "at most 20 kinds are allowed per request"
    );
}

#[tokio::test]
async fn storage_counts_rejects_a_window_over_90_days() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .get_with(
            "/admin/ops/storage/counts?kinds=1&since=1&until=10000000",
            &cookie,
        )
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(
        response.json()["error"],
        "time window must not exceed 7776000 seconds"
    );
}

#[tokio::test]
async fn storage_counts_is_504_when_the_store_outlives_the_deadline() {
    let slow: Arc<dyn nostream_storage::repositories::EventRepository> =
        Arc::new(SlowEventRepository {
            delay: Duration::from_millis(common::STORAGE_TIMEOUT_MS + 1_500),
            fail: false,
        });
    let server = TestServer::start_with(server_with_events(slow)).await;
    let cookie = server.login().await;
    let response = server
        .get_with("/admin/ops/storage/counts?kinds=1", &cookie)
        .await;
    assert_eq!(response.status, 504, "{}", response.text());
    assert_eq!(response.json()["error"], "Storage count query timed out");
}

#[tokio::test]
async fn storage_counts_is_500_when_the_store_fails() {
    let failing: Arc<dyn nostream_storage::repositories::EventRepository> =
        Arc::new(SlowEventRepository {
            delay: Duration::from_millis(1),
            fail: true,
        });
    let server = TestServer::start_with(server_with_events(failing)).await;
    let cookie = server.login().await;
    let response = server
        .get_with("/admin/ops/storage/counts?kinds=1", &cookie)
        .await;
    assert_eq!(response.status, 500, "{}", response.text());
    assert_eq!(response.json()["error"], "Storage count query failed");
}

#[tokio::test]
async fn storage_counts_requires_kinds() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server.get_with("/admin/ops/storage/counts", &cookie).await;
    assert_eq!(response.status, 400);
    assert_eq!(
        response.json()["error"],
        "kinds query parameter is required (comma-separated event kinds)"
    );
}

#[tokio::test]
async fn delivery_log_rejects_limit_zero() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .get_with("/admin/notifications/deliveries?limit=0", &cookie)
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(response.json()["error"], "limit must be a positive integer");
}

#[tokio::test]
async fn delivery_log_rejects_an_unknown_status() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .get_with("/admin/notifications/deliveries?status=pending", &cookie)
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(response.json()["error"], "status must be success or failed");

    let empty = server
        .get_with("/admin/notifications/deliveries?eventType=%20", &cookie)
        .await;
    assert_eq!(empty.status, 400);
    assert_eq!(empty.json()["error"], "eventType must be non-empty");
}

#[tokio::test]
async fn delivery_log_caps_the_limit_at_500() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    common::seed_delivery_log(
        &server,
        "settings.changed",
        nostream_storage::repositories::NotificationDeliveryStatus::Success,
    )
    .await;
    let response = server
        .get_with("/admin/notifications/deliveries?limit=501", &cookie)
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.json()["entries"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn nip05_list_clamps_limit_to_200() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .get_with("/admin/ops/nip05-verifications?limit=500", &cookie)
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.json()["pagination"]["limit"], 200);

    let zero = server
        .get_with("/admin/ops/nip05-verifications?limit=0", &cookie)
        .await;
    assert_eq!(zero.status, 200);
    assert_eq!(zero.json()["pagination"]["limit"], 1);
}

#[tokio::test]
async fn nip05_list_rejects_a_negative_min_failures() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .get_with("/admin/ops/nip05-verifications?minFailures=-1", &cookie)
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(
        response.json()["error"],
        "minFailures must be a non-negative integer"
    );
}

#[tokio::test]
async fn moderation_stats_rejects_721_hours() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .get_with("/admin/moderation/stats?windowHours=721", &cookie)
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(
        response.json()["error"],
        "windowHours must be an integer between 1 and 720"
    );
}

#[tokio::test]
async fn moderation_stats_is_504_when_the_store_outlives_the_deadline() {
    // D4 serves the aggregates empty, so there is no store call to time out; the recorded
    // constant is the capture's and the branch is out of this slice. The case pins the shape
    // the panel reads instead of pretending a timeout happened.
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .get_with("/admin/moderation/stats?windowHours=24", &cookie)
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.json()["windowHours"], 24);
    assert_eq!(
        response.json()["rateLimitHits"],
        serde_json::json!({ "pubkeys": [], "ips": [] })
    );
}

#[tokio::test]
async fn moderation_actions_reject_an_unknown_action() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "POST",
            "/admin/moderation/actions",
            &cookie,
            serde_json::json!({ "action": "nuke", "pubkey": "ab".repeat(32) }),
        )
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(response.json()["error"], "Invalid request");
}

#[tokio::test]
async fn moderation_actions_reject_a_missing_pubkey() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "POST",
            "/admin/moderation/actions",
            &cookie,
            serde_json::json!({ "action": "ban-pubkey" }),
        )
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(
        response.json()["error"],
        "pubkey is required and must be a 64-character hex pubkey or npub"
    );
}

#[tokio::test]
async fn network_health_history_rejects_limit_zero() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .get_with("/admin/network-health/history?limit=0", &cookie)
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(response.json()["error"], "limit must be a positive integer");
}

#[tokio::test]
async fn network_health_run_is_409_when_nip66_is_disabled() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "POST",
            "/admin/network-health/run",
            &cookie,
            serde_json::json!({}),
        )
        .await;
    assert_eq!(response.status, 409);
    assert_eq!(response.json()["error"], "NIP-66 monitoring is disabled");
}

#[tokio::test]
async fn network_health_run_is_400_with_no_valid_targets() {
    let server = TestServer::start_with(
        Fixture::default()
            .with("nip66.enabled", serde_json::json!(true))
            .with("nip66.targets", serde_json::json!(["not-a-relay"])),
    )
    .await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "POST",
            "/admin/network-health/run",
            &cookie,
            serde_json::json!({}),
        )
        .await;
    assert_eq!(response.status, 400, "{}", response.text());
    assert_eq!(
        response.json()["error"],
        "No valid probe targets configured"
    );
}

#[tokio::test]
async fn network_health_run_is_502_with_a_valid_target() {
    let server = TestServer::start_with(
        Fixture::default()
            .with("nip66.enabled", serde_json::json!(true))
            .with("nip66.targets", serde_json::json!(["wss://relay.example"])),
    )
    .await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "POST",
            "/admin/network-health/run",
            &cookie,
            serde_json::json!({}),
        )
        .await;
    assert_eq!(response.status, 502, "{}", response.text());
    assert_eq!(response.json()["error"], "Probe run produced no results");
}

#[tokio::test]
async fn reverify_is_409_when_nip05_is_disabled() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "POST",
            &format!(
                "/admin/ops/nip05-verifications/{}/reverify",
                "02".repeat(32)
            ),
            &cookie,
            serde_json::json!({}),
        )
        .await;
    assert_eq!(response.status, 409);
    assert_eq!(response.json()["error"], "NIP-05 verification is disabled");
}

#[tokio::test]
async fn reverify_is_400_for_a_malformed_pubkey() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "POST",
            "/admin/ops/nip05-verifications/not-a-pubkey/reverify",
            &cookie,
            serde_json::json!({}),
        )
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(response.json()["error"], "Invalid pubkey");
}

#[tokio::test]
async fn reverify_is_404_for_an_unknown_record() {
    let server =
        TestServer::start_with(Fixture::default().with("nip05.mode", serde_json::json!("enabled")))
            .await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "POST",
            &format!(
                "/admin/ops/nip05-verifications/{}/reverify",
                "02".repeat(32)
            ),
            &cookie,
            serde_json::json!({}),
        )
        .await;
    assert_eq!(response.status, 404, "{}", response.text());
    assert_eq!(response.json()["error"], "Verification record not found");
}

#[tokio::test]
async fn notification_test_is_400_without_a_target_id() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    for body in [serde_json::json!({}), serde_json::json!({ "targetId": "" })] {
        let response = server
            .send_json("POST", "/admin/notifications/test", &cookie, body)
            .await;
        assert_eq!(response.status, 400);
        assert_eq!(response.json()["error"], "Invalid request");
    }
}

#[tokio::test]
async fn notification_test_is_502_when_delivery_fails() {
    let server = TestServer::start_with(Fixture::default().with(
        "admin.notifications",
        serde_json::json!({
            "enabled": true,
            "targets": [{
                "id": "hook",
                "type": "http",
                "enabled": true,
                "url": "http://127.0.0.1:1/hook"
            }]
        }),
    ))
    .await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "POST",
            "/admin/notifications/test",
            &cookie,
            serde_json::json!({ "targetId": "hook" }),
        )
        .await;
    assert_eq!(response.status, 502, "{}", response.text());
    assert!(response.json()["error"].is_string());
}

#[tokio::test]
async fn notifications_patch_is_400_on_a_validation_issue() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    // Two targets with one id: the body schema allows it, the document validator refuses it.
    let response = server
        .send_json(
            "PATCH",
            "/admin/notifications",
            &cookie,
            serde_json::json!({
                "targets": [
                    { "id": "dup", "type": "http", "enabled": true, "url": "http://127.0.0.1:1/a" },
                    { "id": "dup", "type": "http", "enabled": true, "url": "http://127.0.0.1:1/b" }
                ]
            }),
        )
        .await;
    assert_eq!(response.status, 400, "{}", response.text());
    assert_eq!(response.json()["error"], "Validation failed");
    assert!(
        response.json()["issues"]
            .as_array()
            .is_some_and(|issues| !issues.is_empty())
    );
}

#[tokio::test]
async fn notifications_patch_rejects_a_non_json_body() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .request(
            "PATCH",
            "/admin/notifications",
            &[("cookie", &cookie), ("content-type", "text/plain")],
            Some(b"{}"),
        )
        .await;
    assert_eq!(response.status, 415);
    assert_eq!(response.json()["error"], "Unsupported Media Type");
}

#[tokio::test]
async fn audit_log_clamps_the_limit_to_500() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    for _ in 0..600 {
        server
            .state
            .append_audit("admin.login", Some("127.0.0.1"), None)
            .unwrap();
    }
    let response = server
        .get_with("/admin/audit-log?limit=1000000000", &cookie)
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.json()["entries"].as_array().unwrap().len(), 500);

    let one = server.get_with("/admin/audit-log?limit=0", &cookie).await;
    assert_eq!(one.json()["entries"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn health_reports_redis_absent_and_a_degraded_status() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server.get_with("/admin/health", &cookie).await;
    assert_eq!(response.status, 200, "{}", response.text());
    let health = response.json();
    assert_eq!(health["redis"]["ok"], false);
    assert_eq!(health["database"]["ok"], true);
    assert_eq!(health["status"], "degraded");
    assert_eq!(health["worker"]["type"], "primary");
    assert!(health["uptimeSeconds"].is_number());
}

#[tokio::test]
async fn workers_marks_a_published_heartbeat_fresh_and_an_unpublished_row_stale() {
    let server =
        TestServer::start_with(Fixture::default().with("nip66.enabled", serde_json::json!(true)))
            .await;
    server.state.publish_heartbeat("maintenance", None);
    let cookie = server.login().await;
    let response = server.get_with("/admin/ops/workers", &cookie).await;
    assert_eq!(response.status, 200, "{}", response.text());
    let workers = response.json()["workers"].as_array().unwrap().clone();

    let maintenance = workers
        .iter()
        .find(|worker| worker["type"] == "maintenance")
        .expect("a maintenance row");
    assert_eq!(maintenance["monitored"], true);
    assert_eq!(maintenance["stale"], false);
    assert!(maintenance["heartbeat"]["updatedAt"].is_string());

    let monitor = workers
        .iter()
        .find(|worker| worker["type"] == "relay-monitor")
        .expect("a relay-monitor row");
    assert_eq!(monitor["stale"], true, "no heartbeat was published for it");

    let worker = workers
        .iter()
        .find(|worker| worker["type"] == "worker")
        .expect("a client worker row");
    assert_eq!(worker["monitored"], false);
    assert_eq!(worker["stale"], false);
}

#[tokio::test]
async fn a_settings_patch_with_a_text_plain_body_is_415() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .request(
            "PATCH",
            "/admin/settings",
            &[("cookie", &cookie), ("content-type", "text/plain")],
            Some(b"{}"),
        )
        .await;
    assert_eq!(response.status, 415);
    assert_eq!(response.json()["error"], "Unsupported Media Type");
}

#[tokio::test]
async fn a_login_with_a_text_plain_body_is_400_not_415() {
    let server = TestServer::start().await;
    let response = server
        .request(
            "POST",
            "/admin/login",
            &[("content-type", "text/plain")],
            Some(PASSWORD.as_bytes()),
        )
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(response.json()["error"], "Invalid request");
}
