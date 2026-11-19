//! AC9–AC20 — the oracle's payload half: one real call per tool, asserting the returned JSON
//! against a fixture of known rows, plus one refusal per tool path.
//!
//! | case | what it proves |
//! |---|---|
//! | `a_kind_filter_returns_only_those_kinds` | `list_events` returns the seeded kind-1 ids and no others, as rows |
//! | `a_limit_is_honoured` | a small `limit` bounds the page |
//! | `no_limit_uses_the_stores_default` | the tool invents no `limit`: 30 rows come back from a call with no arguments |
//! | `an_exact_id_returns_its_row` | `get_event` returns the row's own id, kind and content |
//! | `a_prefix_is_not_an_id` | a 4-character hex prefix is not an id: the payload's event is `null` |
//! | `a_secret_is_redacted` | `settings_get` masks the secret and leaves a non-secret path verbatim |
//! | `an_unknown_key_is_dropped` | `settings_get` drops a key the defaults lack |
//! | `a_set_writes_the_file_its_records_and_a_backup` | a write has the controller's four side effects and its body |
//! | `a_workers_change_is_restart_required` | the reload class is the path's own |
//! | `a_sealed_path_is_refused` | a write-protected path answers the controller's body and writes nothing |
//! | `a_null_value_is_a_validation_failure` | an explicit `null` reaches the validator |
//! | `an_empty_change_list_is_refused` | `{changes: []}` is `Invalid request`, and the attempt is audited |
//! | `an_unknown_tool_is_a_protocol_error` | an absent tool is JSON-RPC `-32602`, not a result |
//! | `bad_arguments_are_an_error_result` | wrong-typed arguments are an `isError` result, not a protocol error |

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::BTreeSet;

use common::{TestMcp, event, id_of, payload, text};
use nostream_mcp::{TOOL_GET_EVENT, TOOL_LIST_EVENTS, TOOL_SETTINGS_GET, TOOL_SETTINGS_SET};
use serde_json::{Value, json};

fn ids(events: &[Value]) -> BTreeSet<String> {
    events
        .iter()
        .map(|record| record["event"]["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_kind_filter_returns_only_those_kinds() {
    let fixture = TestMcp::start().await;
    // Two kind-1 rows and one kind-7 row. The two kind-1 rows need their own secret and
    // creation time: the same arguments twice are one event and one id.
    let seeded = [
        event(1, 1, 1_699_999_900),
        event(2, 1, 1_699_999_901),
        event(3, 7, 1_699_999_902),
    ];
    fixture.seed(&seeded).await;
    let client = fixture.client().await;

    let result = client.call(TOOL_LIST_EVENTS, json!({ "kinds": [1] })).await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let payload = payload(&result);
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 2, "{payload}");
    assert!(
        events.iter().all(|record| record["event"]["kind"] == 1),
        "every row is kind 1: {payload}"
    );
    let expected: BTreeSet<String> = seeded
        .iter()
        .filter(|record| record.event.kind.0 == 1)
        .map(id_of)
        .collect();
    assert_eq!(ids(events), expected, "the seeded kind-1 ids and no others");
}

#[tokio::test]
async fn a_limit_is_honoured() {
    let fixture = TestMcp::start().await;
    fixture
        .seed(&[event(1, 1, 1_699_999_900), event(2, 1, 1_699_999_901)])
        .await;
    let client = fixture.client().await;

    let result = client.call(TOOL_LIST_EVENTS, json!({ "limit": 1 })).await;
    let payload = payload(&result);
    assert_eq!(payload["events"].as_array().unwrap().len(), 1, "{payload}");
}

#[tokio::test]
async fn no_limit_uses_the_stores_default() {
    let fixture = TestMcp::start().await;
    let seeded: Vec<_> = (0..30)
        .map(|index| {
            event(
                u8::try_from(index + 1).unwrap(),
                1,
                1_699_999_000 + i64::from(index),
            )
        })
        .collect();
    fixture.seed(&seeded).await;
    let client = fixture.client().await;

    // No arguments at all: a tool that wrote `limit.unwrap_or(20)` answers 20 here.
    let result = client.call_without_arguments(TOOL_LIST_EVENTS).await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let payload = payload(&result);
    assert_eq!(
        payload["events"].as_array().unwrap().len(),
        30,
        "the store's own default page leaves every seeded row"
    );
}

#[tokio::test]
async fn an_exact_id_returns_its_row() {
    let fixture = TestMcp::start().await;
    let record = event(11, 1, 1_699_999_950);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;

    let result = client.call(TOOL_GET_EVENT, json!({ "id": id })).await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let payload = payload(&result);
    assert_eq!(payload["event"]["event"]["id"], id);
    assert_eq!(payload["event"]["event"]["kind"], 1);
    assert_eq!(payload["event"]["event"]["content"], "11-1699999950");
}

#[tokio::test]
async fn a_prefix_is_not_an_id() {
    let fixture = TestMcp::start().await;
    let record = event(12, 1, 1_699_999_951);
    let id = id_of(&record);
    let prefix = &id[..4];
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;

    // The store's id plan widens a 4-character criterion to a whole-field range, so the read
    // is not empty: only the equality compare makes this a miss.
    let result = client.call(TOOL_GET_EVENT, json!({ "id": prefix })).await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let payload = payload(&result);
    assert!(
        payload["event"].is_null(),
        "a prefix is not an id: {payload}"
    );
}

#[tokio::test]
async fn a_secret_is_redacted() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let result = client.call(TOOL_SETTINGS_GET, json!({})).await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let payload = payload(&result);
    assert_eq!(payload["settings"]["admin"]["passwordHash"], "***");
    assert_eq!(
        payload["settings"]["info"]["relay_url"], "wss://relay.example",
        "a non-secret path is verbatim: {payload}"
    );
}

#[tokio::test]
async fn an_unknown_key_is_dropped() {
    let fixture = TestMcp::start().await;
    let mut settings: serde_yaml::Value = fixture.settings_file();
    settings =
        nostream_config::path::set_by_path(&settings, "customKey", serde_yaml::Value::Bool(true))
            .unwrap();
    fixture.write_settings(&settings);
    let client = fixture.client().await;

    let result = client.call(TOOL_SETTINGS_GET, json!({})).await;
    let payload = payload(&result);
    assert!(
        payload["settings"].get("customKey").is_none(),
        "an unknown key is dropped: {payload}"
    );
    assert!(
        payload["settings"]["admin"].get("passwordHash").is_some(),
        "a passwordHash the defaults lack survives: {payload}"
    );
}

#[tokio::test]
async fn a_set_writes_the_file_its_records_and_a_backup() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let result = client
        .call(
            TOOL_SETTINGS_SET,
            json!({ "path": "wot.enabled", "value": false }),
        )
        .await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    assert_eq!(
        payload(&result),
        json!({ "ok": true, "path": "wot.enabled", "value": false, "reload": "hot-reload" })
    );

    assert_eq!(
        fixture.settings_file()["wot"]["enabled"],
        serde_yaml::Value::Bool(false),
        "the file carries the change"
    );

    let settings_audit = fixture.settings_audit_entries();
    assert_eq!(settings_audit.len(), 1, "{settings_audit:?}");
    assert_eq!(settings_audit[0]["action"], "settings.updated");
    assert_eq!(settings_audit[0]["changes"][0]["path"], "wot.enabled");

    let audit = fixture.audit_entries();
    let actions: Vec<&Value> = audit.iter().map(|entry| &entry["action"]).collect();
    assert_eq!(
        actions,
        vec![&json!("mcp.settings_set"), &json!("settings.updated"),],
        "the dispatch line first, then the shared write path's own"
    );

    let outbox = fixture.outbox().await;
    let events: Vec<&str> = outbox.iter().map(|row| row.event_type.as_str()).collect();
    assert_eq!(events, vec!["settings.changed"], "one row, no others");

    assert_eq!(fixture.backups().len(), 1, "one save, one backup");
}

#[tokio::test]
async fn a_workers_change_is_restart_required() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let result = client
        .call(
            TOOL_SETTINGS_SET,
            json!({ "path": "workers.count", "value": 2 }),
        )
        .await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    assert_eq!(payload(&result)["reload"], "restart-required");
}

#[tokio::test]
async fn a_sealed_path_is_refused() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let result = client
        .call(
            TOOL_SETTINGS_SET,
            json!({ "path": "admin.passwordHash", "value": "scrypt:a:b" }),
        )
        .await;
    assert_eq!(result.is_error, Some(true), "{}", text(&result));
    let refusal: Value = serde_json::from_str(&text(&result)).expect("the body is JSON");
    assert_eq!(refusal["error"], "Validation failed");
    assert_eq!(
        refusal["issues"][0],
        json!({ "path": "admin.passwordHash", "message": "Path is write-protected" })
    );

    let actions: Vec<Value> = fixture
        .audit_entries()
        .iter()
        .map(|entry| entry["action"].clone())
        .collect();
    assert_eq!(
        actions,
        vec![json!("mcp.settings_set")],
        "the attempt is visible and the write is not"
    );
    assert!(
        fixture.settings_audit_entries().is_empty(),
        "no settings line"
    );
    assert!(fixture.backups().is_empty(), "no backup");
}

#[tokio::test]
async fn a_null_value_is_a_validation_failure() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let result = client
        .call(
            TOOL_SETTINGS_SET,
            json!({ "path": "wot.seedPubkey", "value": null }),
        )
        .await;
    assert_eq!(result.is_error, Some(true), "{}", text(&result));
    let refusal: Value = serde_json::from_str(&text(&result)).expect("the body is JSON");
    assert_eq!(refusal["error"], "Validation failed");
    assert_eq!(refusal["issues"][0]["path"], "wot.seedPubkey");
    assert_eq!(refusal["issues"][0]["message"], "Expected string, got null");
}

#[tokio::test]
async fn an_empty_change_list_is_refused() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let result = client
        .call(TOOL_SETTINGS_SET, json!({ "changes": [] }))
        .await;
    assert_eq!(result.is_error, Some(true), "{}", text(&result));
    let refusal: Value = serde_json::from_str(&text(&result)).expect("the body is JSON");
    assert_eq!(refusal["error"], "Invalid request");

    let actions: Vec<Value> = fixture
        .audit_entries()
        .iter()
        .map(|entry| entry["action"].clone())
        .collect();
    assert_eq!(
        actions,
        vec![json!("mcp.settings_set")],
        "the dispatch line exists even though the body was refused"
    );
    assert!(fixture.settings_audit_entries().is_empty());
    assert!(fixture.backups().is_empty());
}

#[tokio::test]
async fn an_unknown_tool_is_a_protocol_error() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let error = client
        .try_call("delete_event", json!({}))
        .await
        .expect_err("an absent tool is a JSON-RPC error, not a result");
    let rmcp::ServiceError::McpError(error) = error else {
        panic!("a protocol error, not a transport failure: {error:?}");
    };
    assert_eq!(error.code.0, -32602, "{error:?}");
    assert!(error.message.contains("tool not found"), "{error:?}");
}

#[tokio::test]
async fn bad_arguments_are_an_error_result() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let result = client
        .try_call(TOOL_GET_EVENT, json!({ "id": 7 }))
        .await
        .expect("wrong-typed arguments are a result, not a protocol error");
    assert_eq!(result.is_error, Some(true), "{}", text(&result));
    assert!(
        text(&result).contains("failed to deserialize parameters"),
        "{}",
        text(&result)
    );
}
