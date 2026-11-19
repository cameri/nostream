//! AC15 — the settings write path: the path guards, the reload class, the backup, the backup
//! list, the restore refusal, the defaults filter and the settings audit line.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::TestServer;
use serde_json::json;

fn audit_lines(server: &TestServer) -> Vec<String> {
    let path = server.config_dir.join("settings-audit.jsonl");
    match std::fs::read_to_string(path) {
        Ok(raw) => raw
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn backup_names(server: &TestServer) -> Vec<String> {
    let dir = server.config_dir.join("backups");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[tokio::test]
async fn a_write_protected_path_is_refused() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({ "path": "admin.passwordHash", "value": "scrypt:a:b" }),
        )
        .await;
    assert_eq!(response.status, 400, "{}", response.text());
    assert_eq!(response.json()["error"], "Validation failed");
    let issues = response.json()["issues"].as_array().unwrap().clone();
    assert_eq!(issues[0]["path"], "admin.passwordHash");
    assert_eq!(issues[0]["message"], "Path is write-protected");
}

#[tokio::test]
async fn a_workers_change_is_restart_required() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({ "path": "workers.count", "value": 2 }),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let body = response.json();
    assert_eq!(body["ok"], true);
    assert_eq!(body["path"], "workers.count");
    assert_eq!(body["value"], 2);
    assert_eq!(body["reload"], "restart-required");
}

#[tokio::test]
async fn a_wot_change_is_hot_reload() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({ "path": "wot.enabled", "value": false }),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.json()["reload"], "hot-reload");
}

#[tokio::test]
async fn a_list_patch_echoes_one_entry_per_change() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({
                "changes": [
                    { "path": "wot.enabled", "value": false },
                    { "path": "network.maxPayloadSize", "value": 250000 }
                ]
            }),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let body = response.json();
    assert_eq!(body["ok"], true);
    let changes = body["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[1]["reload"], "restart-required");
}

#[tokio::test]
async fn an_empty_changes_array_is_refused() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({ "changes": [] }),
        )
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(response.json()["error"], "Invalid request");
}

#[tokio::test]
async fn a_missing_value_is_refused_and_a_null_one_is_allowed() {
    let server = TestServer::start().await;
    let cookie = server.login().await;

    let missing = server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({ "path": "wot.enabled" }),
        )
        .await;
    assert_eq!(missing.status, 400);
    assert_eq!(missing.json()["error"], "Invalid request");

    let null = server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({ "path": "wot.seedPubkey", "value": null }),
        )
        .await;
    assert_ne!(null.status, 400, "a null value is a value: {}", null.text());
}

#[tokio::test]
async fn the_settings_payload_drops_keys_absent_from_the_defaults() {
    let server = TestServer::start().await;
    // A key the defaults document does not carry, written straight into the file.
    let path = server.config_dir.join("settings.yaml");
    let mut document: serde_yaml::Value =
        serde_yaml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    document =
        nostream_config::path::set_by_path(&document, "customKey", serde_yaml::Value::Bool(true))
            .unwrap();
    std::fs::write(&path, serde_yaml::to_string(&document).unwrap()).unwrap();

    let cookie = server.login().await;
    let response = server.get_with("/admin/settings", &cookie).await;
    assert_eq!(response.status, 200, "{}", response.text());
    let settings = &response.json()["settings"];
    assert!(
        settings.get("customKey").is_none(),
        "an unknown key is dropped"
    );

    let defaults = common::defaults_document();
    assert!(defaults.get("admin").is_some());
    assert!(
        settings["admin"].get("passwordHash").is_some(),
        "a passwordHash key the defaults lack survives: {settings}"
    );
    assert_eq!(
        settings["admin"]["passwordHash"], "***",
        "and it is redacted"
    );
}

#[tokio::test]
async fn a_save_writes_a_backup() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let response = server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({ "path": "wot.enabled", "value": false }),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());

    let names = backup_names(&server);
    assert_eq!(names.len(), 1, "one backup after one save: {names:?}");
    assert!(
        nostream_config::store::is_backup_filename(&names[0]),
        "the backup's name is the capture's pattern: {}",
        names[0]
    );
}

#[tokio::test]
async fn the_backup_list_shows_the_new_file() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({ "path": "wot.enabled", "value": false }),
        )
        .await;
    let saved = backup_names(&server);
    assert_eq!(saved.len(), 1);

    let response = server.get_with("/admin/settings/backups", &cookie).await;
    assert_eq!(response.status, 200, "{}", response.text());
    let backups = response.json()["backups"].as_array().unwrap().clone();
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0]["filename"], saved[0].as_str());
    assert!(backups[0]["createdAt"].is_string());
    assert!(backups[0]["sizeBytes"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn a_non_matching_backup_name_is_refused() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    for filename in [
        "settings.yaml",
        "../settings.yaml",
        "settings.2026-11-19.yaml",
    ] {
        let response = server
            .send_json(
                "POST",
                "/admin/settings/restore",
                &cookie,
                json!({ "filename": filename }),
            )
            .await;
        assert_eq!(response.status, 400, "{filename}: {}", response.text());
        assert_eq!(response.json()["error"], "Invalid backup filename");
    }
}

#[tokio::test]
async fn a_save_appends_one_audit_line() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    assert!(audit_lines(&server).is_empty(), "no line before the save");

    server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({ "path": "wot.enabled", "value": false }),
        )
        .await;

    let lines = audit_lines(&server);
    assert_eq!(lines.len(), 1, "one line per save: {lines:?}");
    let entry: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
    assert!(entry["timestamp"].is_string(), "timestamp first: {entry}");
    assert_eq!(entry["action"], "settings.updated");
    assert_eq!(entry["changes"][0]["path"], "wot.enabled");
    assert_eq!(entry["changes"][0]["reload"], "hot-reload");
}

#[tokio::test]
async fn a_save_records_one_admin_audit_entry() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({ "path": "wot.enabled", "value": false }),
        )
        .await;
    let response = server.get_with("/admin/audit-log?limit=100", &cookie).await;
    let entries = response.json()["entries"].as_array().unwrap().clone();
    assert!(
        entries
            .iter()
            .any(|entry| entry["action"] == "settings.updated"),
        "the settings change is in the audit log: {entries:?}"
    );
    assert!(entries.iter().all(|entry| entry["at"].is_string()));
    assert!(entries.iter().all(|entry| entry["id"].is_string()));
}

#[tokio::test]
async fn a_restore_of_a_valid_backup_rewrites_the_settings() {
    let server = TestServer::start().await;
    let cookie = server.login().await;

    // A save first, so a genuine backup exists with a known document.
    server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({ "path": "wot.enabled", "value": false }),
        )
        .await;
    let backup = backup_names(&server).pop().unwrap();

    // Then a second change, which the restore must undo.
    let changed = server
        .send_json(
            "PATCH",
            "/admin/settings",
            &cookie,
            json!({ "path": "info.name", "value": "Changed" }),
        )
        .await;
    assert_eq!(changed.status, 200, "{}", changed.text());

    let restored = server
        .send_json(
            "POST",
            "/admin/settings/restore",
            &cookie,
            json!({ "filename": backup }),
        )
        .await;
    assert_eq!(restored.status, 200, "{}", restored.text());
    assert_eq!(restored.json()["ok"], true);
    assert_eq!(restored.json()["filename"], backup.as_str());

    let settings = server.get_with("/admin/settings", &cookie).await;
    assert_ne!(settings.json()["settings"]["info"]["name"], "Changed");
}
