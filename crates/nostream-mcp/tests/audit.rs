//! AC22 — one audit line per executed call, and none for a refused one.
//!
//! | case | what it proves |
//! |---|---|
//! | `each_call_appends_one_line` | four calls append five lines in call order — the four `mcp.*` lines, then `settings_set`'s own `settings.updated` |
//! | `a_refused_call_appends_nothing` | a call with bad arguments and a call with no token each leave the file untouched |
//! | `every_registered_tool_is_in_the_audit_table` | the audit table is total: no tool the router registers can execute unaudited |
//! | `the_audit_check_is_no_stricter_than_the_router` | the table's rule is the router's deserialiser, not the schema: a stricter check would fail open |
//!
//! R9 appends the `mcp.*` line at dispatch, before the handler's work, so the order in the file
//! is the order of the calls and a domain line always follows its own dispatch line.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::BTreeSet;

use common::{Fixture, TestMcp, Token, event, id_of, object, text};
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

#[tokio::test]
async fn every_registered_tool_is_in_the_audit_table() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    // The router's own list: `tools/list` is what `ToolRouter::list_all()` answers, so a tool
    // added with a `#[tool]` method and no table entry is in `registered` and nowhere else.
    let registered: BTreeSet<String> = client
        .tools()
        .await
        .iter()
        .map(|tool| tool.name.to_string())
        .collect();
    for name in &registered {
        assert!(
            nostream_mcp::arguments_parse(name, None).is_some(),
            "tool {name} is registered but has no TOOL_ARGUMENTS entry, so its calls would \
             execute unaudited"
        );
    }
    let tabled: BTreeSet<String> = nostream_mcp::TOOL_ARGUMENTS
        .iter()
        .map(|(name, _)| (*name).to_owned())
        .collect();
    assert_eq!(
        tabled, registered,
        "the table names exactly the tools the router registers"
    );
}

/// The table's rule is "no stricter than the router's own deserialiser", not "the shape the
/// `inputSchema` states": `call_tool` writes the line and then dispatches unconditionally, so a
/// check that refused a call the router runs would execute it unaudited — R9 failing open.
#[tokio::test]
async fn the_audit_check_is_no_stricter_than_the_router() {
    // `settings_set` takes a raw map, so its check is deliberately vacuous and its schema is the
    // half that refuses. Repairing the check to `settings_patch(..).is_some()` — the obvious
    // reading of "the shape the schema states" — would write no line for `{"foo": 1}` while the
    // router still ran the handler.
    assert_eq!(
        nostream_mcp::arguments_parse(TOOL_SETTINGS_SET, Some(&object(json!({ "foo": 1 })))),
        Some(true),
        "a check stricter than the router's deserialisation fails open: the line is written \
         before the dispatch, so a call this refused would execute unaudited"
    );

    let fixture = TestMcp::start().await;
    let client = fixture.client().await;
    let refused = client.call(TOOL_SETTINGS_SET, json!({ "foo": 1 })).await;
    assert_eq!(refused.is_error, Some(true), "{}", text(&refused));
    assert!(
        text(&refused).contains("Invalid request"),
        "the handler refused it, so the router ran it: {}",
        text(&refused)
    );
    let actions: Vec<String> = fixture
        .audit_entries()
        .iter()
        .map(|entry| entry["action"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(
        actions,
        vec![audit_action(TOOL_SETTINGS_SET)],
        "the dispatched-but-refused call wrote its line"
    );
}
