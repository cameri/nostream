//! AC22 — one audit line per executed call, and none for a call no tool reached.
//!
//! | case | what it proves |
//! |---|---|
//! | `each_call_appends_one_line` | fourteen calls append fifteen lines in call order — the fourteen `mcp.*` lines, then `settings_set`'s own `settings.updated` |
//! | `a_refused_call_appends_nothing` | a call with bad arguments and a call with no credential each leave the file untouched |
//! | `every_registered_tool_has_a_table_row` | the table is total over the router's own list, so no tool can execute unaudited or ungated |
//! | `the_audit_check_is_no_stricter_than_the_router` | the table's rule is the router's deserialiser, not the schema: a stricter check would fail open |
//! | `the_write_tools_detail_carries_only_the_tool` | the three write tools' lines carry `{"tool": …}` and nothing else: no id, no action, no count, no address |
//! | `the_store_tools_detail_carries_only_the_tool` | the five store tools' lines carry `{"tool": …}` and nothing else: no pubkey, no action, no invoice id |
//! R9 appends the `mcp.*` line at dispatch, before the handler's work, so the order in the file
//! is the order of the calls and a domain line always follows its own dispatch line. The one
//! refusal that does write is a credential's scope denial — `mcp.denied`, R28 — and it has its
//! own case beside the credential, in `tests/auth.rs`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::BTreeSet;

use common::{TestMcp, event, id_of, object, text};
use nostream_mcp::{
    TOOL_DELETE_EVENT, TOOL_GET_EVENT, TOOL_INVOICES_GET, TOOL_INVOICES_LIST, TOOL_LIST_EVENTS,
    TOOL_MAINTENANCE_LAST_RUN, TOOL_MAINTENANCE_RUN, TOOL_RELAY_STATUS, TOOL_REPORTS_ACTION,
    TOOL_REPORTS_LIST, TOOL_SETTINGS_GET, TOOL_SETTINGS_SET, TOOL_USER_ADMIN, TOOL_USER_GET, TOOLS,
    audit_action,
};
use serde_json::json;

#[tokio::test]
async fn each_call_appends_one_line() {
    let fixture = TestMcp::start().await;
    let record = event(21, 1, 1_699_999_960);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;
    let pubkey = "ab".repeat(32);

    client.call(TOOL_SETTINGS_GET, json!({})).await;
    client.call(TOOL_LIST_EVENTS, json!({})).await;
    client.call(TOOL_GET_EVENT, json!({ "id": id })).await;
    client.call(TOOL_DELETE_EVENT, json!({ "id": id })).await;
    let report_id = "ab".repeat(32);
    client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": report_id, "action": "allow" }),
        )
        .await;
    client.call(TOOL_REPORTS_LIST, json!({})).await;
    client
        .call(
            TOOL_USER_ADMIN,
            json!({ "pubkey": pubkey.clone(), "action": "admit" }),
        )
        .await;
    client
        .call(TOOL_USER_GET, json!({ "pubkey": pubkey }))
        .await;
    client.call(TOOL_INVOICES_LIST, json!({})).await;
    client
        .call(TOOL_INVOICES_GET, json!({ "id": "inv-1" }))
        .await;
    client.call(TOOL_RELAY_STATUS, json!({})).await;
    client.call(TOOL_MAINTENANCE_LAST_RUN, json!({})).await;
    client.call(TOOL_MAINTENANCE_RUN, json!({})).await;
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
            "mcp.delete_event",
            "mcp.reports_action",
            "mcp.reports_list",
            "mcp.user_admin",
            "mcp.user_get",
            "mcp.invoices_list",
            "mcp.invoices_get",
            "mcp.relay_status",
            "mcp.maintenance_last_run",
            "mcp.maintenance_run",
            "mcp.settings_set",
            "settings.updated",
        ],
        "call order, with the write path's own line from its own call: {entries:?}"
    );

    for (entry, tool) in entries.iter().zip([
        TOOL_SETTINGS_GET,
        TOOL_LIST_EVENTS,
        TOOL_GET_EVENT,
        TOOL_DELETE_EVENT,
        TOOL_REPORTS_ACTION,
        TOOL_REPORTS_LIST,
        TOOL_USER_ADMIN,
        TOOL_USER_GET,
        TOOL_INVOICES_LIST,
        TOOL_INVOICES_GET,
        TOOL_RELAY_STATUS,
        TOOL_MAINTENANCE_LAST_RUN,
        TOOL_MAINTENANCE_RUN,
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
        entries[10]["detail"]["tool"],
        json!(TOOL_RELAY_STATUS),
        "the eleventh line is the status call's own: {entries:?}"
    );
    assert_eq!(
        entries[13]["detail"]["paths"],
        json!(["wot.enabled"]),
        "the settings write names the paths it asked for, never the values"
    );
    assert!(
        entries[13]["detail"].get("value").is_none(),
        "no value is recorded: {}",
        entries[13]
    );
}

/// R24: the three write tools' lines carry the tool and nothing else. A `detail` carrying the id,
/// the action or a count would let a caller's own text shape a record, which the `settings_set`
/// arm deliberately does not do — it passes the requested paths, which are its request.
#[tokio::test]
async fn the_write_tools_detail_carries_only_the_tool() {
    let fixture = TestMcp::start().await;
    let record = event(22, 1, 1_699_999_961);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;

    let deleted = client.call(TOOL_DELETE_EVENT, json!({ "id": id })).await;
    assert_eq!(deleted.is_error, Some(false), "{}", text(&deleted));
    let report_id = "cd".repeat(32);
    let acted = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": report_id, "action": "allow" }),
        )
        .await;
    assert_eq!(acted.is_error, Some(false), "{}", text(&acted));
    // The purge over a fixture with no retention configured is the guard's three zeros, so this
    // is a write whose answer carries numbers and whose line must not.
    let purged = client.call(TOOL_MAINTENANCE_RUN, json!({})).await;
    assert_eq!(purged.is_error, Some(false), "{}", text(&purged));
    let entries = fixture.audit_entries();
    let actions: Vec<String> = entries
        .iter()
        .map(|entry| entry["action"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(
        actions,
        vec![
            audit_action(TOOL_DELETE_EVENT),
            audit_action(TOOL_REPORTS_ACTION),
            audit_action(TOOL_MAINTENANCE_RUN)
        ],
        "{entries:?}"
    );
    for (entry, tool) in
        entries
            .iter()
            .zip([TOOL_DELETE_EVENT, TOOL_REPORTS_ACTION, TOOL_MAINTENANCE_RUN])
    {
        assert_eq!(
            entry["detail"],
            json!({ "tool": tool }),
            "{tool}'s detail names the tool and nothing else: {entry}"
        );
        assert!(
            entry.get("remoteAddress").is_none(),
            "a stdio caller has no address: {entry}"
        );
    }
}

/// R22, R27: the five store tools' lines carry the tool and nothing else. A `detail` carrying the
/// pubkey, the action or an invoice id would let a caller's own text shape a record — the reason
/// `dispatch_detail` adds nothing for them. The action is compared through `audit_action` rather
/// than spelled: `each_call_appends_one_line`'s vector stays the file's only list of literals.
#[tokio::test]
async fn the_store_tools_detail_carries_only_the_tool() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;
    let pubkey = "ab".repeat(32);

    for (tool, arguments) in [
        (
            TOOL_USER_ADMIN,
            json!({ "pubkey": pubkey, "action": "admit" }),
        ),
        (TOOL_USER_GET, json!({ "pubkey": pubkey })),
        (TOOL_INVOICES_LIST, json!({})),
        (TOOL_INVOICES_GET, json!({ "id": "inv-1" })),
        (TOOL_REPORTS_LIST, json!({})),
    ] {
        let result = client.call(tool, arguments).await;
        assert_eq!(result.is_error, Some(false), "{tool}: {}", text(&result));
    }

    let entries = fixture.audit_entries();
    let actions: Vec<String> = entries
        .iter()
        .map(|entry| entry["action"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(
        actions,
        vec![
            audit_action(TOOL_USER_ADMIN),
            audit_action(TOOL_USER_GET),
            audit_action(TOOL_INVOICES_LIST),
            audit_action(TOOL_INVOICES_GET),
            audit_action(TOOL_REPORTS_LIST),
        ],
        "{entries:?}"
    );
    for (entry, tool) in entries.iter().zip([
        TOOL_USER_ADMIN,
        TOOL_USER_GET,
        TOOL_INVOICES_LIST,
        TOOL_INVOICES_GET,
        TOOL_REPORTS_LIST,
    ]) {
        assert_eq!(
            entry["detail"],
            json!({ "tool": tool }),
            "{tool}'s detail names the tool and nothing else: {entry}"
        );
        assert!(
            entry.get("remoteAddress").is_none(),
            "a stdio caller has no address: {entry}"
        );
    }
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

    // A second server whose token file is deleted before the call: the credential is gone, so
    // there is nothing to attribute a line to (R28).
    let untokened = TestMcp::start().await;
    untokened.revoke();
    let unauthenticated = untokened.client().await;
    let refused = unauthenticated.call(TOOL_SETTINGS_GET, json!({})).await;
    assert_eq!(refused.is_error, Some(true));
    assert!(
        untokened.audit_entries().is_empty(),
        "a refused credential writes nothing"
    );
}

#[tokio::test]
async fn every_registered_tool_has_a_table_row() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    // The router's own list: `tools/list` is what `ToolRouter::list_all()` answers, so a tool
    // added with a `#[tool]` method and no row is in `registered` and nowhere else.
    let registered: BTreeSet<String> = client
        .tools()
        .await
        .iter()
        .map(|tool| tool.name.to_string())
        .collect();
    for name in &registered {
        assert!(
            TOOLS.iter().any(|row| row.name == name),
            "tool {name} is registered but has no TOOLS row, so its calls would execute \
             unaudited and with no scope declared"
        );
    }
    let tabled: BTreeSet<String> = TOOLS.iter().map(|row| row.name.to_owned()).collect();
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
