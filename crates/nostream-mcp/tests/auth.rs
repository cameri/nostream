//! AC29–AC34, AC38, AC39 — the door's own credential: a scoped token document, by file or
//! descriptor, and the scope table that decides what it may call.
//!
//! | case | what it proves |
//! |---|---|
//! | `a_revoked_token_refuses_every_tool` | a deleted document answers `Unauthorized` to all seven tools, writes nothing, and still lists them |
//! | `a_read_only_token_is_refused_the_write` | a document with no scope reads and is refused `settings_set`, and the denial is a line in `admin-audit.jsonl` |
//! | `a_disabled_surface_is_refused` | `admin.enabled: false` answers `Not Found`, as the console does |
//! | `an_unknown_scope_refuses_the_load` | a document naming a scope the door does not know is refused when it is loaded, naming the scope and the accepted set |
//! | `a_file_rewrite_changes_the_decision` | rewriting the file on a running server narrows the write, and rewriting it back restores it: the file's lifetime is the credential's |
//! | `an_inherited_descriptor_authenticates` | the descriptor form answers `tools/list` and a read, and keeps the grant it was handed when the file it came from changes |
//! | `only_the_writing_tool_needs_a_scope` | the table names every registered tool and declares a scope for each: the four read tools read, the three writes need `write`, and a name the table does not carry needs `write` |
//! | `an_unregistered_tool_is_refused_before_the_scopes` | a name the surface does not register is refused with the router's own `-32602` before the scope decision, so a read-only document writes no denial line for it |
//! | `a_group_readable_descriptor_refuses_to_start` | a `0644` document on a descriptor is refused as the same file by path is |
//! | `a_device_descriptor_refuses_to_start` | a device on the descriptor is refused before a byte is read, so `/dev/zero` cannot hang the start |
//! | `an_oversized_document_is_refused` | a document over the size bound is refused on both forms, naming its size and the cap |
//!
//! Each case builds its own server with the credential as a **value**, and none sets an
//! environment variable: cases in one binary run in parallel, so an environment-based credential
//! would race. The two refusal texts are distinct on purpose — a gate that collapsed `Not Found`
//! and `Unauthorized` could pass a case written against the wrong arm.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::BTreeSet;
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;

use common::{Fixture, Grant, TestMcp, text, write_token};
use nostream_mcp::{
    AUDIT_DENIED, Credential, FORBIDDEN, MAX_TOKEN_DOCUMENT_BYTES, NOT_FOUND, Requires,
    TOOL_DELETE_EVENT, TOOL_GET_EVENT, TOOL_LIST_EVENTS, TOOL_RELAY_STATUS, TOOL_REPORTS_ACTION,
    TOOL_SETTINGS_GET, TOOL_SETTINGS_SET, TOOLS, UNAUTHORIZED, audit_action, required_scope,
};
use serde_json::json;

/// The seven tools, each with arguments its schema accepts, so the refusal cannot be a
/// deserialisation failure in disguise.
fn calls() -> [(&'static str, serde_json::Value); 7] {
    [
        (TOOL_SETTINGS_GET, json!({})),
        (
            TOOL_SETTINGS_SET,
            json!({ "path": "wot.enabled", "value": false }),
        ),
        (TOOL_LIST_EVENTS, json!({})),
        (TOOL_GET_EVENT, json!({ "id": "0123456789abcdef" })),
        (TOOL_DELETE_EVENT, json!({ "id": "0123456789abcdef" })),
        (
            TOOL_REPORTS_ACTION,
            json!({ "id": "ab".repeat(32), "action": "hide" }),
        ),
        (TOOL_RELAY_STATUS, json!({})),
    ]
}

#[tokio::test]
async fn a_revoked_token_refuses_every_tool() {
    let fixture = TestMcp::start().await;
    // Deleting the file is the revocation (R29): no store, no restart, no session to expire.
    fixture.revoke();
    let client = fixture.client().await;

    assert_eq!(client.tools().await.len(), 7, "tools/list is not gated");
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
    // The one document refusal that used to leave the location implicit: it names the file now,
    // as the parse refusal beside it does (R27).
    assert!(
        message.contains(&document.display().to_string()),
        "the document it read: {message}"
    );

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
    std::fs::set_permissions(&readable, std::fs::Permissions::from_mode(0o644)).unwrap();
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
    assert_eq!(names.len(), 7, "{names:?}");

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

    // The expected sets come from the table's own column and the router's own list, never from
    // `required_scope`: a case that filtered `tools/list` through the function under test would
    // drop the tool the function has no row for, which is the tool this case exists to catch.
    let registered: BTreeSet<String> = client
        .tools()
        .await
        .iter()
        .map(|tool| tool.name.to_string())
        .collect();
    let tabled: BTreeSet<String> = TOOLS.iter().map(|row| row.name.to_owned()).collect();
    assert_eq!(tabled, registered, "every registered tool declares a scope");

    let mut reading: Vec<&str> = TOOLS
        .iter()
        .filter(|row| row.needs == Requires::Read)
        .map(|row| row.name)
        .collect();
    let mut writing: Vec<&str> = TOOLS
        .iter()
        .filter(|row| row.needs == Requires::Write)
        .map(|row| row.name)
        .collect();
    reading.sort_unstable();
    writing.sort_unstable();
    assert_eq!(
        reading,
        vec![
            TOOL_GET_EVENT,
            TOOL_LIST_EVENTS,
            TOOL_RELAY_STATUS,
            TOOL_SETTINGS_GET
        ],
        "reading is the grant every document carries"
    );
    assert_eq!(
        writing,
        vec![TOOL_DELETE_EVENT, TOOL_REPORTS_ACTION, TOOL_SETTINGS_SET],
        "the tools that change the relay are the ones a document opts into"
    );

    // A name the table does not carry needs the write: that is this helper's answer for it, and
    // the reason a missing row fails closed rather than open. `call_tool` refuses such a name
    // before it asks — see `an_unregistered_tool_is_refused_before_the_scopes` — so a rowless tool
    // never reaches dispatch at all.
    assert_eq!(required_scope("user_admin"), Requires::Write);
}

/// A name the surface does not register is refused before the scope decision, so a document that
/// grants no write writes nothing for it: the answer is the router's own `-32602 tool not found`,
/// the same one a `write` document gets (R9, R28). A registered tool that arrived without its row
/// is refused by the same check, which is what makes it unreachable rather than unaudited.
#[tokio::test]
async fn an_unregistered_tool_is_refused_before_the_scopes() {
    let fixture = TestMcp::start_with(Fixture {
        grant: Grant::Read,
        ..Fixture::default()
    })
    .await;
    let client = fixture.client().await;

    let error = client
        .try_call("user_admin", json!({}))
        .await
        .expect_err("a name the table does not carry is not a tool");
    let rmcp::ServiceError::McpError(error) = error else {
        panic!("a protocol error, not a transport failure: {error:?}");
    };
    assert_eq!(error.code.0, -32602, "{error:?}");
    assert!(error.message.contains("tool not found"), "{error:?}");
    assert!(
        fixture.audit_entries().is_empty(),
        "an unknown name is not a denied write, so it writes no line"
    );
}

/// The descriptor is a way to deliver the document, not a way around its rules: a `0644` file on
/// a descriptor is refused as the same file by path is (R27).
#[tokio::test]
async fn a_group_readable_descriptor_refuses_to_start() {
    let fixture = TestMcp::start().await;
    // The descriptor is opened before the mode widens, so the case refuses the mode and not an
    // open.
    let file = fixture.descriptor();
    std::fs::set_permissions(&fixture.token_path, std::fs::Permissions::from_mode(0o644)).unwrap();

    let refused = Credential::from_descriptor(file.as_raw_fd())
        .expect_err("the descriptor's target carries a group permission");
    let message = refused.to_string();
    assert!(message.contains("0644"), "{message}");
    assert!(message.contains("0600"), "the usual mode: {message}");
    assert!(
        message.contains("no group or other permission"),
        "{message}"
    );
}

/// A device on the descriptor is refused before a byte is read, so `/dev/zero` — which never ends
/// a read — cannot hang the start (R27). The call runs on a thread of its own under a deadline:
/// the failure this case exists to catch is one that never returns, and a bound inside the case's
/// own thread could not fire on a call that blocks it, so a regression would hang the suite
/// instead of failing it.
#[tokio::test]
async fn a_device_descriptor_refuses_to_start() {
    let zero = std::fs::File::open("/dev/zero").expect("/dev/zero is a device this host has");
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let answer = Credential::from_descriptor(zero.as_raw_fd())
            .map(|_| ())
            .map_err(|error| error.to_string());
        let _ = sender.send(answer);
    });
    let refused = receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("reading /dev/zero as a token document returned in five seconds")
        .expect_err("a device is not a token document");
    assert!(refused.contains("not a regular file"), "{refused}");
}

/// The document's size is bounded, so neither read is an amount of work the path chooses: a file
/// over the bound is refused, naming the size it found and the cap (R27).
#[tokio::test]
async fn an_oversized_document_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("oversized.json");
    let over = usize::try_from(MAX_TOKEN_DOCUMENT_BYTES).unwrap() + 1;
    common::write_private(&path, &" ".repeat(over));

    let refused = Credential::from_file(&path).expect_err("a document has a size bound");
    let message = refused.to_string();
    assert!(
        message.contains(&over.to_string()),
        "the size it found: {message}"
    );
    assert!(
        message.contains(&MAX_TOKEN_DOCUMENT_BYTES.to_string()),
        "the cap: {message}"
    );

    // The same bound on the descriptor's target: one comparison on the metadata both forms
    // already read.
    let file = std::fs::File::open(&path).unwrap();
    let refused = Credential::from_descriptor(file.as_raw_fd()).expect_err("the same bound");
    assert!(
        refused
            .to_string()
            .contains(&MAX_TOKEN_DOCUMENT_BYTES.to_string()),
        "{refused}"
    );
}
