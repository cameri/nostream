//! AC22 — one audit line per executed call, and none for a refused one.
//!
//! | case | what it proves |
//! |---|---|
//! | `each_call_appends_one_line` | four calls append five lines in call order — the four `mcp.*` lines, then `settings_set`'s own `settings.updated` |
//! | `a_refused_call_appends_nothing` | a call with bad arguments and a call with no token each leave the file untouched |
//!
//! R9 appends the `mcp.*` line at dispatch, before the handler's work, so the order in the file
//! is the order of the calls and a domain line always follows its own dispatch line.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{Fixture, TestMcp, Token, event, id_of, text};
use nostream_mcp::{
    TOOL_GET_EVENT, TOOL_LIST_EVENTS, TOOL_SETTINGS_GET, TOOL_SETTINGS_SET, audit_action,
};
use serde_json::json;

#[tokio::test]
async fn each_call_appends_one_line() {
    let fixture = TestMcp::start().await;
    let record = event(21, 1, 1_699_999_960);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;

    client.call(TOOL_SETTINGS_GET, json!({})).await;
    client.call(TOOL_LIST_EVENTS, json!({})).await;
    client.call(TOOL_GET_EVENT, json!({ "id": id })).await;
    let written = client
        .call(
            TOOL_SETTINGS_SET,
            json!({ "path": "wot.enabled", "value": false }),
        )
        .await;
    assert_eq!(written.is_error, Some(false), "{}", text(&written));

    let entries = fixture.audit_entries();
    let actions: Vec<&str> = entries
        .iter()
        .map(|entry| entry["action"].as_str().unwrap())
        .collect();
    assert_eq!(
        actions,
        vec![
            "mcp.settings_get",
            "mcp.list_events",
            "mcp.get_event",
            "mcp.settings_set",
            "settings.updated",
        ],
        "call order, with the write path's own line from its own call: {entries:?}"
    );

    for (entry, tool) in entries.iter().zip([
        TOOL_SETTINGS_GET,
        TOOL_LIST_EVENTS,
        TOOL_GET_EVENT,
        TOOL_SETTINGS_SET,
    ]) {
        assert_eq!(entry["action"], audit_action(tool));
        assert!(
            entry.get("remoteAddress").is_none(),
            "a stdio caller has no address: {entry}"
        );
        assert_eq!(entry["detail"]["tool"], tool);
        assert!(entry["id"].as_str().is_some_and(|id| !id.is_empty()));
        assert!(entry["at"].as_str().is_some());
    }

    assert_eq!(
        entries[3]["detail"]["paths"],
        json!(["wot.enabled"]),
        "the settings write names the paths it asked for, never the values"
    );
    assert!(
        entries[3]["detail"].get("value").is_none(),
        "no value is recorded: {}",
        entries[3]
    );
}

#[tokio::test]
async fn a_refused_call_appends_nothing() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;
    let error = client
        .try_call(TOOL_GET_EVENT, json!({ "id": 7 }))
        .await
        .expect("a tool result");
    assert_eq!(error.is_error, Some(true));
    assert!(
        fixture.audit_entries().is_empty(),
        "an argument the schema refuses is refused before dispatch"
    );

    // A second server, built with no token, over its own config dir.
    let untokened = TestMcp::start_with(Fixture {
        token: Token::Absent,
        ..Fixture::default()
    })
    .await;
    let unauthenticated = untokened.client().await;
    let refused = unauthenticated.call(TOOL_SETTINGS_GET, json!({})).await;
    assert_eq!(refused.is_error, Some(true));
    assert!(
        untokened.audit_entries().is_empty(),
        "a refused credential writes nothing"
    );
}
