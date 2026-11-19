//! AC13 — the 26 API rows of R5, one case each, named after its route: status, the top-level
//! keys of its body exactly as the table lists them, and `content-type: application/json` on
//! every JSON answer. The fixture's `nip66.enabled` is false, so `/network-health/run` is its
//! `409` branch (D3).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{PASSWORD, Response, TestServer};
use serde_json::json;

/// A server and a session cookie: one per case, so a case that writes settings cannot
/// disturb another.
async fn ready() -> (TestServer, String) {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    (server, cookie)
}

fn assert_keys(response: &Response, keys: &[&str]) {
    assert_value_keys(&response.json(), keys, &response.text());
}

fn assert_value_keys(value: &serde_json::Value, keys: &[&str], body: &str) {
    let serde_json::Value::Object(object) = value else {
        panic!("expected an object: {body}");
    };
    let mut found: Vec<String> = object.keys().cloned().collect();
    let mut expected: Vec<String> = keys.iter().map(|key| (*key).to_owned()).collect();
    found.sort();
    expected.sort();
    assert_eq!(found, expected, "body: {body}");
}

fn assert_json(response: &Response) {
    assert_eq!(
        response.content_type(),
        "application/json",
        "content type at {}: {}",
        response.status,
        response.text()
    );
}

fn base_settings(server: &TestServer) -> std::path::PathBuf {
    server.config_dir.join("settings.yaml")
}

#[tokio::test]
async fn get_session_answers_the_authenticated_shape() {
    let (server, cookie) = ready().await;
    let response = server.get_with("/admin/session", &cookie).await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["authenticated", "expiresAt"]);
    assert_eq!(response.json()["authenticated"], true);
}

#[tokio::test]
async fn post_login_answers_the_authenticated_shape_and_sets_the_cookie() {
    let server = TestServer::start().await;
    let response = server
        .request(
            "POST",
            "/admin/login",
            &[("content-type", "application/json")],
            Some(format!("{{\"password\":\"{PASSWORD}\"}}").as_bytes()),
        )
        .await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["authenticated", "expiresAt"]);
    assert!(response.header("set-cookie").is_some());
}

#[tokio::test]
async fn post_logout_answers_the_cleared_session() {
    let (server, cookie) = ready().await;
    let response = server
        .request("POST", "/admin/logout", &[("cookie", &cookie)], None)
        .await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["authenticated"]);
    assert_eq!(response.json()["authenticated"], false);
    assert!(
        response.header("set-cookie").unwrap().contains("Max-Age=0"),
        "the cookie is cleared"
    );
}

#[tokio::test]
async fn get_metrics_answers_an_event_stream() {
    let (server, cookie) = ready().await;
    let response = server.get_with("/admin/metrics", &cookie).await;
    assert_eq!(response.status, 200);
    assert_eq!(response.content_type(), "text/event-stream; charset=utf-8");
    assert!(
        response.text().starts_with("data: "),
        "a frame arrives at once"
    );
}

#[tokio::test]
async fn get_network_health_answers_the_snapshot() {
    let (server, cookie) = ready().await;
    let response = server.get_with("/admin/network-health", &cookie).await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["snapshot"]);
    assert!(response.json()["snapshot"].is_null());
}

#[tokio::test]
async fn get_network_health_history_answers_the_runs() {
    let (server, cookie) = ready().await;
    let response = server
        .get_with("/admin/network-health/history", &cookie)
        .await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["runs"]);
    assert_eq!(response.json()["runs"], json!([]));
}

#[tokio::test]
async fn post_network_health_run_is_409_when_nip66_is_disabled() {
    let (server, cookie) = ready().await;
    let response = server
        .send_json("POST", "/admin/network-health/run", &cookie, json!({}))
        .await;
    assert_eq!(response.status, 409, "{}", response.text());
    assert_json(&response);
    assert_keys(&response, &["error"]);
    assert_eq!(response.json()["error"], "NIP-66 monitoring is disabled");
}

#[tokio::test]
async fn get_settings_answers_the_settings() {
    let (server, cookie) = ready().await;
    let response = server.get_with("/admin/settings", &cookie).await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["settings"]);
}

#[tokio::test]
async fn get_settings_schema_answers_the_categories() {
    let (server, cookie) = ready().await;
    let response = server.get_with("/admin/settings/schema", &cookie).await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["categories"]);
    let categories = response.json()["categories"].as_array().unwrap().clone();
    assert!(!categories.is_empty());
    assert!(
        categories[0]["settings"][0].get("validate").is_none(),
        "the validator member is stripped"
    );
}

#[tokio::test]
async fn post_settings_validate_answers_the_findings() {
    let (server, cookie) = ready().await;
    let response = server
        .send_json("POST", "/admin/settings/validate", &cookie, json!({}))
        .await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["valid", "issues"]);
    assert_eq!(response.json()["valid"], true);
}

#[tokio::test]
async fn get_settings_backups_answers_the_backups() {
    let (server, cookie) = ready().await;
    let response = server.get_with("/admin/settings/backups", &cookie).await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["backups"]);
}

#[tokio::test]
async fn patch_settings_answers_the_single_change() {
    let (server, cookie) = ready().await;
    let response = server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({ "path": "wot.enabled", "value": false }),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_json(&response);
    assert_keys(&response, &["ok", "path", "value", "reload"]);
    assert_eq!(response.json()["reload"], "hot-reload");
}

#[tokio::test]
async fn post_settings_restore_answers_the_restored_filename() {
    let (server, cookie) = ready().await;
    let backups = server.config_dir.join("backups");
    std::fs::create_dir_all(&backups).unwrap();
    let name = "settings.2026-11-19T13-19-32-000Z.yaml";
    let document = std::fs::read_to_string(base_settings(&server)).unwrap();
    std::fs::write(backups.join(name), document).unwrap();

    let response = server
        .send_json(
            "POST",
            "/admin/settings/restore",
            &cookie,
            json!({ "filename": name }),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_json(&response);
    assert_keys(&response, &["ok", "filename"]);
}

#[tokio::test]
async fn get_notifications_answers_the_block() {
    let (server, cookie) = ready().await;
    let response = server.get_with("/admin/notifications", &cookie).await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["notifications"]);
}

#[tokio::test]
async fn patch_notifications_answers_the_block() {
    let (server, cookie) = ready().await;
    let response = server
        .send_json(
            "PATCH",
            "/admin/notifications",
            &cookie,
            json!({ "enabled": true }),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_json(&response);
    assert_keys(&response, &["ok", "notifications"]);
    assert_eq!(response.json()["notifications"]["enabled"], true);
}

#[tokio::test]
async fn post_notification_test_is_502_for_an_unknown_target() {
    let (server, cookie) = ready().await;
    let response = server
        .send_json(
            "POST",
            "/admin/notifications/test",
            &cookie,
            json!({ "targetId": "missing" }),
        )
        .await;
    assert_eq!(response.status, 502, "{}", response.text());
    assert_json(&response);
    assert_keys(&response, &["error"]);
}

#[tokio::test]
async fn get_notifications_deliveries_answers_the_entries() {
    let (server, cookie) = ready().await;
    let response = server
        .get_with("/admin/notifications/deliveries", &cookie)
        .await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["entries"]);
}

#[tokio::test]
async fn get_ops_workers_answers_the_rows() {
    let (server, cookie) = ready().await;
    let response = server.get_with("/admin/ops/workers", &cookie).await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["workers"]);
    assert!(!response.json()["workers"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn get_ops_nip05_verifications_answers_the_page() {
    let (server, cookie) = ready().await;
    let response = server
        .get_with("/admin/ops/nip05-verifications", &cookie)
        .await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(
        &response,
        &["verifications", "pagination", "verifyExpirationMs"],
    );
    assert_value_keys(
        &response.json()["pagination"],
        &["limit", "offset", "total"],
        &response.text(),
    );
}

#[tokio::test]
async fn post_ops_nip05_reverify_is_409_when_disabled() {
    let (server, cookie) = ready().await;
    let response = server
        .send_json(
            "POST",
            &format!(
                "/admin/ops/nip05-verifications/{}/reverify",
                "02".repeat(32)
            ),
            &cookie,
            json!({}),
        )
        .await;
    assert_eq!(response.status, 409, "{}", response.text());
    assert_json(&response);
    assert_keys(&response, &["error"]);
}

#[tokio::test]
async fn get_ops_storage_counts_answers_the_counts() {
    let (server, cookie) = ready().await;
    let response = server
        .get_with("/admin/ops/storage/counts?kinds=1,2", &cookie)
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_json(&response);
    assert_keys(&response, &["since", "until", "counts"]);
    assert_eq!(response.json()["counts"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn get_audit_log_answers_the_entries() {
    let (server, cookie) = ready().await;
    let response = server.get_with("/admin/audit-log", &cookie).await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["entries"]);
}

#[tokio::test]
async fn get_diagnostics_export_answers_the_payload() {
    let (server, cookie) = ready().await;
    let response = server.get_with("/admin/diagnostics/export", &cookie).await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(
        &response,
        &[
            "generatedAt",
            "version",
            "health",
            "settings",
            "notifications",
            "networkHealth",
            "operations",
        ],
    );
    assert!(
        response.header("content-disposition").is_none(),
        "inline by default"
    );

    let download = server
        .get_with("/admin/diagnostics/export?download=1", &cookie)
        .await;
    assert_eq!(download.status, 200);
    let disposition = download.header("content-disposition").unwrap();
    assert!(
        disposition.starts_with("attachment; filename=\"nostream-diagnostics-"),
        "{disposition}"
    );
}

#[tokio::test]
async fn get_moderation_limits_answers_the_limits() {
    let (server, cookie) = ready().await;
    let response = server.get_with("/admin/moderation/limits", &cookie).await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(&response, &["limits"]);
    assert_value_keys(
        &response.json()["limits"],
        &["pubkey", "kind", "rateLimitBypass"],
        &response.text(),
    );
}

#[tokio::test]
async fn get_moderation_stats_answers_the_summary() {
    let (server, cookie) = ready().await;
    let response = server
        .get_with("/admin/moderation/stats?windowHours=168&limit=15", &cookie)
        .await;
    assert_eq!(response.status, 200);
    assert_json(&response);
    assert_keys(
        &response,
        &[
            "windowHours",
            "since",
            "topPublishingPubkeys",
            "topClientIps",
            "rateLimitHits",
        ],
    );
}

#[tokio::test]
async fn post_moderation_actions_answers_the_limits() {
    let (server, cookie) = ready().await;
    let banned = "ab".repeat(32);
    let response = server
        .send_json(
            "POST",
            "/admin/moderation/actions",
            &cookie,
            json!({ "action": "ban-pubkey", "pubkey": banned }),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_json(&response);
    assert_keys(&response, &["ok", "limits"]);
    let limits = server.get_with("/admin/moderation/limits", &cookie).await;
    assert!(
        limits.text().contains(&banned),
        "the banned pubkey appears in the next read: {}",
        limits.text()
    );
}
