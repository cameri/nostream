//! The settings write path as one step: a single audit entry per action, one save at a time,
//! and the `settings.changed` row both moderation routes queue.
//!
//! | case | what it proves |
//! |---|---|
//! | `a_moderation_action_appends_one_audit_entry_with_its_detail` | the action is audited once, and that entry carries the detail |
//! | `every_concurrent_settings_save_lands` | six overlapping `PATCH /settings` requests each keep their change |
//! | `a_moderation_action_enqueues_the_settings_changed_row` | the action queues `settings.changed`, not an event the operator cannot toggle |
//! | `a_limits_patch_enqueues_the_settings_changed_row` | the limits route goes through the same save flow and queues one too |

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use tokio::io::AsyncWriteExt as _;

use common::TestServer;
use nostream_storage::repositories::OutboxMessage;
use serde_json::json;
use tokio::net::TcpStream;

/// The audit entries the file holds, oldest first.
fn audit_entries(server: &TestServer) -> Vec<serde_json::Value> {
    let path = server.config_dir.join("admin-audit.jsonl");
    std::fs::read_to_string(path)
        .map(|raw| {
            raw.lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| serde_json::from_str(line).expect("an audit line"))
                .collect()
        })
        .unwrap_or_default()
}

/// The rows the outbox holds, oldest first.
async fn outbox_rows(server: &TestServer) -> Vec<OutboxMessage> {
    server
        .state
        .stores()
        .notification_outbox
        .claim_batch(50)
        .await
        .expect("the outbox")
}

fn user_settings(server: &TestServer) -> serde_yaml::Value {
    serde_yaml::from_str(
        &std::fs::read_to_string(server.config_dir.join("settings.yaml"))
            .expect("the settings file"),
    )
    .expect("the settings document")
}

#[tokio::test]
async fn a_moderation_action_appends_one_audit_entry_with_its_detail() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let pubkey = "02".repeat(32);

    let response = server
        .send_json(
            "POST",
            "/admin/moderation/actions",
            &cookie,
            json!({ "action": "ban-pubkey", "pubkey": pubkey }),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());

    let entries: Vec<serde_json::Value> = audit_entries(&server)
        .into_iter()
        .filter(|entry| entry["action"] == "moderation.action")
        .collect();
    assert_eq!(
        entries.len(),
        1,
        "one moderation action is one audit entry, not one without its detail and one with it: {entries:?}"
    );
    assert_eq!(
        entries[0]["detail"]["pubkey"], pubkey,
        "the one entry carries the detail"
    );
    assert_eq!(entries[0]["detail"]["action"], "ban-pubkey");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_concurrent_settings_save_lands() {
    let server = TestServer::start().await;
    let cookie = server.login().await;

    let changes = [
        ("info.name", json!("concurrent-name")),
        ("info.description", json!("concurrent-description")),
        ("info.banner", json!("https://relay.example/banner.png")),
        ("info.icon", json!("https://relay.example/icon.png")),
        ("info.contact", json!("mailto:operator@relay.example")),
        ("wot.minimumFollowers", json!(2)),
    ];

    // Every request is written before any response is read, so all six handlers are in their
    // read-change-validate-write sequence at once.
    let mut streams = Vec::new();
    for (path, value) in &changes {
        let mut stream = TcpStream::connect(server.addr).await.expect("connect");
        let body = json!({ "path": path, "value": value }).to_string();
        let request = format!(
            "PATCH /admin/settings HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\ncookie: {cookie}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
            server.addr.port(),
            body.len()
        );
        stream.write_all(request.as_bytes()).await.expect("write");
        stream.flush().await.expect("flush");
        streams.push(stream);
    }

    let mut statuses = Vec::new();
    for mut stream in streams {
        let response = common::read_response(&mut stream).await;
        statuses.push(response.status);
    }

    let document = user_settings(&server);
    let mut missing = Vec::new();
    for (path, value) in &changes {
        let written = nostream_config::path::get_by_path(&document, path)
            .expect("a settings path")
            .cloned();
        let expected: serde_yaml::Value =
            serde_yaml::from_str(&value.to_string()).expect("the expected value");
        if written != Some(expected) {
            missing.push(*path);
        }
    }
    assert_eq!(
        missing,
        Vec::<&str>::new(),
        "a concurrent save overwrote another's change: {document:?}"
    );
    assert_eq!(statuses, vec![200; changes.len()], "every save answers 200");
}

#[tokio::test]
async fn a_moderation_action_enqueues_the_settings_changed_row() {
    let server = TestServer::start().await;
    let cookie = server.login().await;

    let response = server
        .send_json(
            "POST",
            "/admin/moderation/actions",
            &cookie,
            json!({ "action": "ban-pubkey", "pubkey": "02".repeat(32) }),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());

    let rows = outbox_rows(&server).await;
    let events: Vec<&str> = rows.iter().map(|row| row.event_type.as_str()).collect();
    assert_eq!(
        events,
        vec!["settings.changed"],
        "a moderation action queues the operator's settings-change message and nothing else"
    );
    let payload = &rows[0].payload;
    let paths: Vec<&str> = payload["changes"]
        .as_array()
        .expect("a changes list")
        .iter()
        .map(|change| change["path"].as_str().expect("a path"))
        .collect();
    assert_eq!(
        paths,
        vec![
            "limits.event.pubkey",
            "limits.event.kind",
            "limits.event.whitelists"
        ],
        "the message names the settings the action changed"
    );
    assert_eq!(
        payload["remoteAddress"], "127.0.0.1",
        "the message carries the client's address"
    );
}

#[tokio::test]
async fn a_limits_patch_enqueues_the_settings_changed_row() {
    let server = TestServer::start().await;
    let cookie = server.login().await;

    let response = server
        .send_json(
            "PATCH",
            "/admin/moderation/limits",
            &cookie,
            json!({ "pubkey": { "blacklist": ["02".repeat(32)] } }),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());

    let rows = outbox_rows(&server).await;
    assert_eq!(
        rows.len(),
        1,
        "the limits patch queues the settings-change message"
    );
    assert_eq!(rows[0].event_type, "settings.changed");
    assert_eq!(
        rows[0].payload["changes"][0]["path"], "limits.event.pubkey",
        "the message names a settings path the patch changed"
    );
}
