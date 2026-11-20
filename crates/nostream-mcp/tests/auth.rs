//! AC29–AC34 — the door's own credential: a scoped token document, by file or descriptor.
//!
//! | case | what it proves |
//! |---|---|
//! | `a_revoked_token_refuses_every_tool` | a deleted document answers `Unauthorized` to all four tools, writes nothing, and still lists them |
//! | `a_read_only_token_is_refused_the_write` | a document with no scope reads and is refused `settings_set`, and the denial is a line in `admin-audit.jsonl` |
//! | `a_disabled_surface_is_refused` | `admin.enabled: false` answers `Not Found`, as the console does |
//! | `an_unknown_scope_refuses_the_load` | a document naming a scope the door does not know is refused when it is loaded, naming the scope and the accepted set |
//! | `a_file_rewrite_changes_the_decision` | rewriting the file on a running server narrows the write, and rewriting it back restores it: the file's lifetime is the credential's |
//! | `an_inherited_descriptor_authenticates` | the descriptor form answers `tools/list` and a read, and keeps the grant it was handed when the file it came from changes |
//! | `only_the_writing_tool_needs_a_scope` | the read tools need no scope, and `settings_set` is the one that does |
//!
//! Each case builds its own server with the credential as a **value**, and none sets an
//! environment variable: cases in one binary run in parallel, so an environment-based credential
//! would race. The two refusal texts are distinct on purpose — a gate that collapsed `Not Found`
//! and `Unauthorized` could pass a case written against the wrong arm.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::os::fd::AsRawFd;

use common::{Fixture, Grant, TestMcp, text, write_token};
use nostream_mcp::{
    AUDIT_DENIED, Credential, FORBIDDEN, NOT_FOUND, TOOL_GET_EVENT, TOOL_LIST_EVENTS,
    TOOL_SETTINGS_GET, TOOL_SETTINGS_SET, UNAUTHORIZED, audit_action, required_scope,
};
use serde_json::json;

/// The four tools, each with arguments its schema accepts, so the refusal cannot be a
/// deserialisation failure in disguise.
fn calls() -> [(&'static str, serde_json::Value); 4] {
    [
        (TOOL_SETTINGS_GET, json!({})),
        (
            TOOL_SETTINGS_SET,
            json!({ "path": "wot.enabled", "value": false }),
        ),
        (TOOL_LIST_EVENTS, json!({})),
        (TOOL_GET_EVENT, json!({ "id": "0123456789abcdef" })),
    ]
}

#[tokio::test]
async fn a_revoked_token_refuses_every_tool() {
    let fixture = TestMcp::start().await;
    // Deleting the file is the revocation (R29): no store, no restart, no session to expire.
    fixture.revoke();
    let client = fixture.client().await;

    assert_eq!(client.tools().await.len(), 4, "tools/list is not gated");
    for (tool, arguments) in calls() {
        let result = client.call(tool, arguments).await;
        assert_eq!(result.is_error, Some(true), "{tool}: {}", text(&result));
        assert_eq!(text(&result), UNAUTHORIZED, "{tool}");
    }
    assert!(
        fixture.audit_entries().is_empty(),
        "a call with no credential has nothing to attribute a line to"
    );
}

#[tokio::test]
async fn a_read_only_token_is_refused_the_write() {
    let fixture = TestMcp::start_with(Fixture {
        grant: Grant::Read,
        ..Fixture::default()
    })
    .await;
    let client = fixture.client().await;

    let read = client.call(TOOL_SETTINGS_GET, json!({})).await;
    assert_eq!(read.is_error, Some(false), "{}", text(&read));

    let denied = client
        .call(
            TOOL_SETTINGS_SET,
            json!({ "path": "wot.enabled", "value": false }),
        )
        .await;
    assert_eq!(denied.is_error, Some(true), "{}", text(&denied));
    let refusal = text(&denied);
    assert!(refusal.contains(FORBIDDEN), "{refusal}");
    assert!(refusal.contains(TOOL_SETTINGS_SET), "{refusal}");
    assert!(refusal.contains("write"), "{refusal}");

    // The refusal is an authenticated call that was denied, so it is written down (R28) — after
    // the read's own dispatch line, in call order.
    let entries = fixture.audit_entries();
    let actions: Vec<&str> = entries
        .iter()
        .map(|entry| entry["action"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        actions,
        vec![audit_action(TOOL_SETTINGS_GET).as_str(), AUDIT_DENIED],
        "{entries:?}"
    );
    assert_eq!(entries[1]["detail"]["tool"], TOOL_SETTINGS_SET);
    assert_eq!(entries[1]["detail"]["scope"], "write");
    assert!(
        entries[1].get("remoteAddress").is_none(),
        "a stdio caller has no address"
    );

    // Nothing of the write ran: no file change, no audit line of its own, no backup.
    assert!(
        fixture.settings_file()["wot"]["enabled"].is_null(),
        "the refused write left the file alone"
    );
    assert!(fixture.settings_audit_entries().is_empty());
    assert!(fixture.backups().is_empty(), "no backup");
}

#[tokio::test]
async fn a_disabled_surface_is_refused() {
    let fixture = TestMcp::start_with(Fixture::default().with("admin.enabled", json!(false))).await;
    let client = fixture.client().await;

    let result = client.call(TOOL_SETTINGS_GET, json!({})).await;
    assert_eq!(result.is_error, Some(true));
    assert_eq!(text(&result), NOT_FOUND);
    assert!(fixture.audit_entries().is_empty());
}

#[tokio::test]
async fn an_unknown_scope_refuses_the_load() {
    let temp = tempfile::tempdir().unwrap();
    let document = write_token(temp.path(), &["admin"]);

    let refused = Credential::from_file(&document).expect_err("an unknown scope is not a grant");
    let message = refused.to_string();
    assert!(message.contains("\"admin\""), "{message}");
    assert!(message.contains("write"), "the accepted set: {message}");

    // A document still carrying the retired session token is refused for its shape, not read for
    // less than it says: the load names the key it did not expect.
    let half_migrated = temp.path().join("half-migrated.json");
    common::write_private(&half_migrated, r#"{"token": "a-session-token"}"#);
    let refused = Credential::from_file(&half_migrated).expect_err("the shape is closed");
    assert!(refused.to_string().contains("token"), "{refused}");

    // The load check is the mode's start-up check: a token file at a mode anyone but the owner
    // can read is refused before the door serves anything (R27).
    let readable = temp.path().join("readable.json");
    common::write_private(&readable, &common::token_document(&["write"]));
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&readable, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    let refused = Credential::from_file(&readable).expect_err("0644 is not 0600");
    assert!(refused.to_string().contains("0644"), "{refused}");
    assert!(refused.to_string().contains("0600"), "{refused}");
}

#[tokio::test]
async fn a_file_rewrite_changes_the_decision() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let written = client
        .call(
            TOOL_SETTINGS_SET,
            json!({ "path": "wot.enabled", "value": false }),
        )
        .await;
    assert_eq!(written.is_error, Some(false), "{}", text(&written));

    // The document is narrowed to reads on a running server: nothing else happens.
    fixture.write_scopes(&[]);
    let denied = client
        .call(
            TOOL_SETTINGS_SET,
            json!({ "path": "wot.enabled", "value": true }),
        )
        .await;
    assert_eq!(denied.is_error, Some(true), "{}", text(&denied));
    assert!(text(&denied).contains(FORBIDDEN), "{}", text(&denied));
    let actions: Vec<String> = fixture
        .audit_entries()
        .iter()
        .map(|entry| entry["action"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(actions.last().map(String::as_str), Some(AUDIT_DENIED));
    assert!(
        fixture.settings_file()["wot"]["enabled"] == serde_yaml::Value::Bool(false),
        "the denied write left the file as it was"
    );

    let read = client.call(TOOL_SETTINGS_GET, json!({})).await;
    assert_eq!(read.is_error, Some(false), "{}", text(&read));

    // And back: the next call is decided by the file as it stands now.
    fixture.write_scopes(&["write"]);
    let restored = client
        .call(
            TOOL_SETTINGS_SET,
            json!({ "path": "wot.enabled", "value": false }),
        )
        .await;
    assert_eq!(restored.is_error, Some(false), "{}", text(&restored));
}

#[tokio::test]
async fn an_inherited_descriptor_authenticates() {
    let fixture = TestMcp::start().await;
    let file = fixture.descriptor();
    let credential = Credential::from_descriptor(file.as_raw_fd()).expect("the document loads");
    let client = fixture.client_with_credential(credential).await;

    let names: Vec<String> = client
        .tools()
        .await
        .iter()
        .map(|tool| tool.name.to_string())
        .collect();
    assert_eq!(names.len(), 4, "{names:?}");

    let read = client.call(TOOL_SETTINGS_GET, json!({})).await;
    assert_eq!(read.is_error, Some(false), "{}", text(&read));

    // The descriptor was read once at start, so it holds the grant it carried: the file it came
    // from is not consulted again, which is the asymmetry the mode's documentation states (R29).
    fixture.write_scopes(&[]);
    let written = client
        .call(
            TOOL_SETTINGS_SET,
            json!({ "path": "wot.enabled", "value": false }),
        )
        .await;
    assert_eq!(written.is_error, Some(false), "{}", text(&written));
}

#[tokio::test]
async fn only_the_writing_tool_needs_a_scope() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let scoped: Vec<String> = client
        .tools()
        .await
        .iter()
        .filter(|tool| required_scope(&tool.name).is_some())
        .map(|tool| tool.name.to_string())
        .collect();
    assert_eq!(
        scoped,
        vec![TOOL_SETTINGS_SET.to_owned()],
        "reading is the document's default; the one tool that changes the relay is the one it \
         has to opt into"
    );
}
