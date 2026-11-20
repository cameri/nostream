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
//! | `an_unknown_argument_is_an_argument_error` | a mistyped key is an argument error naming the accepted fields, not an unfiltered page |
//! | `an_uppercase_id_finds_its_row` | a stored id pasted in uppercase is the same id, not a confident `null` |
//! | `a_criterion_the_wire_would_refuse_is_an_argument_error` | a non-hex, short, oversized or over-counted criterion is refused, naming its field |
//! | `a_refused_criterion_never_reaches_the_store` | the refusal comes before the store: over the unwired store the argument error answers, not `NotImplemented` |
//! | `a_page_is_the_first_rows_oldest_first` | the payload is one order, and `limit` is its first N, with `truncated` marking a full page |
//! | `a_full_default_page_is_marked_truncated` | a page the store's own bound cut says so |
//! | `a_success_carries_one_copy_of_the_payload` | a success is in `structuredContent` only, never also as a text block |
//! | `the_settings_schema_forbids_what_the_handler_refuses` | the published schema and the handler agree on the two accepted shapes |

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::BTreeSet;

use common::{Fixture, Stores, TestMcp, event, id_of, payload, text};
use nostream_mcp::{TOOL_GET_EVENT, TOOL_LIST_EVENTS, TOOL_SETTINGS_GET, TOOL_SETTINGS_SET};
use nostream_storage::repositories::EventRepository;
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
    // The refusal precedes the scope decision and the dispatch line on this arm too: the read-only
    // arm's case asserts the same empty file (`tests/auth.rs`), and this is the one that would have
    // caught a line for a call that reached no tool.
    assert!(
        fixture.audit_entries().is_empty(),
        "an absent name writes no line: {:?}",
        fixture.audit_entries()
    );
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

#[tokio::test]
async fn an_unknown_argument_is_an_argument_error() {
    let fixture = TestMcp::start().await;
    fixture
        .seed(&[event(31, 1, 1_699_999_956), event(32, 7, 1_699_999_957)])
        .await;
    let client = fixture.client().await;

    // The field a client works from is `kinds`; `kind` is one character of plural away, and a
    // serde struct that drops what it does not know answers every row as if no criterion had
    // been given — a complete-looking page of the wrong rows.
    let mistyped = client.call(TOOL_LIST_EVENTS, json!({ "kind": [1] })).await;
    assert_eq!(mistyped.is_error, Some(true), "{}", text(&mistyped));
    let message = text(&mistyped);
    assert!(
        message.contains("unknown field `kind`")
            && message.contains("`kinds`")
            && message.contains("`limit`"),
        "the refusal names the key it got and the keys it takes: {message}"
    );
    assert!(
        fixture.audit_entries().is_empty(),
        "a call the router's deserialiser refuses reaches no tool and writes nothing"
    );

    // The same rule in the published schema, which a validating client reads before it calls.
    let tools = client.tools().await;
    for name in [TOOL_LIST_EVENTS, TOOL_GET_EVENT] {
        let tool = tools
            .iter()
            .find(|tool| tool.name == name)
            .unwrap_or_else(|| panic!("{name} is listed"));
        let schema = Value::Object((*tool.input_schema).clone());
        assert_eq!(
            schema["additionalProperties"],
            json!(false),
            "{name} admits no key its handler does not take: {schema}"
        );
    }

    // The same rule on `get_event`, whose `id` is required: an extra key used to be harmless
    // there — the row came back — and is an argument error now.
    let record = event(33, 7, 1_699_999_958);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let extra = client
        .call(TOOL_GET_EVENT, json!({ "id": id, "fields": ["content"] }))
        .await;
    assert_eq!(extra.is_error, Some(true), "{}", text(&extra));
    assert!(
        text(&extra).contains("unknown field `fields`"),
        "{}",
        text(&extra)
    );

    // The control: the right key is a page of exactly the rows that match.
    let rows = client.call(TOOL_LIST_EVENTS, json!({ "kinds": [1] })).await;
    assert_eq!(rows.is_error, Some(false), "{}", text(&rows));
    assert_eq!(
        payload(&rows)["events"].as_array().unwrap().len(),
        1,
        "{}",
        text(&rows)
    );
}

#[tokio::test]
async fn an_uppercase_id_finds_its_row() {
    let fixture = TestMcp::start().await;
    let record = event(13, 1, 1_699_999_952);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;

    let result = client
        .call(TOOL_GET_EVENT, json!({ "id": id.to_uppercase() }))
        .await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let payload = payload(&result);
    assert_eq!(
        payload["event"]["event"]["id"], id,
        "the uppercase form of a stored id is that id: {payload}"
    );
}

#[tokio::test]
async fn a_criterion_the_wire_would_refuse_is_an_argument_error() {
    let fixture = TestMcp::start().await;
    let record = event(14, 1, 1_699_999_953);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;

    let over_cap: Vec<String> = (0..65).map(|index| format!("{index:04x}")).collect();
    let refused = [
        (TOOL_GET_EVENT, json!({ "id": "" }), "id"),
        (TOOL_GET_EVENT, json!({ "id": "ze" }), "id"),
        (TOOL_GET_EVENT, json!({ "id": &id[..3] }), "id"),
        (TOOL_GET_EVENT, json!({ "id": format!("{id}0") }), "id"),
        (TOOL_LIST_EVENTS, json!({ "ids": ["ze"] }), "ids"),
        (TOOL_LIST_EVENTS, json!({ "ids": [&id[..3]] }), "ids"),
        (
            TOOL_LIST_EVENTS,
            json!({ "authors": ["npub1qqqq"] }),
            "authors",
        ),
        (TOOL_LIST_EVENTS, json!({ "ids": over_cap }), "ids"),
        (TOOL_LIST_EVENTS, json!({ "limit": 0 }), "limit"),
        (TOOL_LIST_EVENTS, json!({ "limit": 501 }), "limit"),
    ];
    for (tool, arguments, field) in refused {
        let answer = client.call(tool, arguments.clone()).await;
        assert_eq!(
            answer.is_error,
            Some(true),
            "{tool} {arguments}: {}",
            text(&answer)
        );
        assert!(
            text(&answer).starts_with(&format!("{field}:")),
            "{tool} {arguments} names `{field}`: {}",
            text(&answer)
        );
    }

    // The control: the stored id is a criterion the wire takes.
    let found = client.call(TOOL_GET_EVENT, json!({ "id": id })).await;
    assert_eq!(found.is_error, Some(false), "{}", text(&found));
    assert_eq!(payload(&found)["event"]["event"]["id"], id);
}

#[tokio::test]
async fn a_refused_criterion_never_reaches_the_store() {
    let fixture = TestMcp::start_with(Fixture {
        stores: Stores::Unavailable,
        ..Fixture::default()
    })
    .await;
    let client = fixture.client().await;

    // Over the daemon's unwired bundle every read answers `NotImplemented`, so a refusal that
    // arrives instead is one made before the store was touched.
    let refused = client.call(TOOL_GET_EVENT, json!({ "id": "" })).await;
    assert_eq!(refused.is_error, Some(true), "{}", text(&refused));
    assert!(text(&refused).starts_with("id:"), "{}", text(&refused));
    assert!(
        !text(&refused).contains("storage::backend::wiring"),
        "the refusal is not the store's: {}",
        text(&refused)
    );

    let reached = client.call(TOOL_GET_EVENT, json!({ "id": "abcd" })).await;
    assert_eq!(reached.is_error, Some(true), "{}", text(&reached));
    assert!(
        text(&reached).contains("not implemented in Phase 1 (job 005): storage::backend::wiring"),
        "a criterion the wire takes reaches the store: {}",
        text(&reached)
    );
}

#[tokio::test]
async fn a_page_is_the_first_rows_oldest_first() {
    let fixture = TestMcp::start().await;
    let seeded: Vec<_> = (0..12)
        .map(|index| {
            event(
                u8::try_from(index + 40).unwrap(),
                1,
                1_699_998_000 + i64::from(index),
            )
        })
        .collect();
    fixture.seed(&seeded).await;
    let client = fixture.client().await;

    let result = client.call(TOOL_LIST_EVENTS, json!({ "limit": 5 })).await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let page = payload(&result);
    let created: Vec<i64> = page["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["event"]["created_at"].as_i64().unwrap())
        .collect();
    assert_eq!(
        created,
        vec![
            1_699_998_000,
            1_699_998_001,
            1_699_998_002,
            1_699_998_003,
            1_699_998_004
        ],
        "a limited page is the first rows in the same order: {page}"
    );
    assert_eq!(page["truncated"], json!(true), "the page is full: {page}");

    let whole = client.call_without_arguments(TOOL_LIST_EVENTS).await;
    let whole = payload(&whole);
    assert_eq!(whole["events"].as_array().unwrap().len(), 12, "{whole}");
    assert_eq!(
        whole["truncated"],
        json!(false),
        "nothing was cut, so the marker is false: {whole}"
    );
}

#[tokio::test]
async fn a_full_default_page_is_marked_truncated() {
    let fixture = TestMcp::start().await;
    let seeded: Vec<_> = (0..=500)
        .map(|index| event(1, 1, 1_699_000_000 + index))
        .collect();
    fixture.seed(&seeded).await;
    let client = fixture.client().await;

    let result = client.call_without_arguments(TOOL_LIST_EVENTS).await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let payload = payload(&result);
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 500, "the store's own page bound");
    assert_eq!(
        events[0]["event"]["created_at"],
        json!(1_699_000_000),
        "and the page starts at the oldest row"
    );
    assert_eq!(
        payload["truncated"],
        json!(true),
        "501 rows match, so the full page is cut: {payload}"
    );
}

#[tokio::test]
async fn a_success_carries_one_copy_of_the_payload() {
    let fixture = TestMcp::start().await;
    fixture
        .seed(&[event(15, 1, 1_699_999_954), event(16, 1, 1_699_999_955)])
        .await;
    let client = fixture.client().await;

    for (tool, arguments) in [
        (TOOL_SETTINGS_GET, json!({})),
        (TOOL_LIST_EVENTS, json!({})),
        (TOOL_GET_EVENT, json!({ "id": "abcd" })),
        (
            TOOL_SETTINGS_SET,
            json!({ "path": "wot.enabled", "value": false }),
        ),
    ] {
        let answer = client.call(tool, arguments).await;
        assert_eq!(answer.is_error, Some(false), "{tool}: {}", text(&answer));
        assert!(
            answer.content.is_empty(),
            "{tool} sends the payload once, not also as a text block: {:?}",
            answer.content
        );
        assert!(
            answer.structured_content.is_some(),
            "{tool} answers with structured content"
        );
    }
}

#[tokio::test]
async fn the_settings_schema_forbids_what_the_handler_refuses() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let refused = client
        .call(
            TOOL_SETTINGS_SET,
            json!({ "path": "wot.enabled", "value": true, "note": "x" }),
        )
        .await;
    assert_eq!(refused.is_error, Some(true), "{}", text(&refused));
    let refusal: Value = serde_json::from_str(&text(&refused)).expect("the body is JSON");
    assert_eq!(refusal["error"], "Invalid request");

    let schema = client
        .tools()
        .await
        .into_iter()
        .find(|tool| tool.name == TOOL_SETTINGS_SET)
        .expect("settings_set is listed");
    let schema = Value::Object((*schema.input_schema).clone());
    assert_eq!(
        schema["oneOf"].as_array().map(Vec::len),
        Some(2),
        "the schema models exactly the two accepted bodies: {schema}"
    );
    let shapes = schema["oneOf"].as_array().unwrap();
    for shape in shapes {
        assert_eq!(
            shape["additionalProperties"],
            json!(false),
            "no shape allows another key: {shape}"
        );
    }
    assert_eq!(shapes[0]["required"], json!(["path", "value"]), "{schema}");
    assert_eq!(
        shapes[1]["properties"]["changes"]["items"]["additionalProperties"],
        json!(false),
        "a change carries `path` and `value` and nothing else: {schema}"
    );
    assert_eq!(
        shapes[1]["properties"]["changes"]["minItems"],
        json!(1),
        "{schema}"
    );

    // `parse_change` refuses an empty path (`admin_json_body_middleware.rs:138-140`), so the
    // advertisement says it too: the schema is what a validating client reads, the handler is
    // what enforces.
    assert_eq!(
        shapes[0]["properties"]["path"]["minLength"],
        json!(1),
        "an empty path is not a change: {schema}"
    );
    assert_eq!(
        shapes[1]["properties"]["changes"]["items"]["properties"]["path"]["minLength"],
        json!(1),
        "nor is it one in a list: {schema}"
    );
    let empty_path = client
        .call(TOOL_SETTINGS_SET, json!({ "path": "", "value": 1 }))
        .await;
    assert_eq!(empty_path.is_error, Some(true), "{}", text(&empty_path));
    let empty_path: Value = serde_json::from_str(&text(&empty_path)).expect("a refusal body");
    assert_eq!(
        empty_path["error"], "Invalid request",
        "the handler refuses what the schema now forbids"
    );

    // Every shape the schema allows, the handler takes.
    let accepted = client
        .call(
            TOOL_SETTINGS_SET,
            json!({ "changes": [{ "path": "wot.enabled", "value": false }] }),
        )
        .await;
    assert_eq!(accepted.is_error, Some(false), "{}", text(&accepted));
    let null_value = client
        .call(
            TOOL_SETTINGS_SET,
            json!({ "path": "wot.seedPubkey", "value": null }),
        )
        .await;
    let null_value: Value = serde_json::from_str(&text(&null_value)).expect("a refusal body");
    assert_eq!(
        null_value["error"], "Validation failed",
        "an explicit null is a value the schema allows and the validator judges"
    );
}

/// A page that spent its slots and lost one to a vanished row is complete, not short.
///
/// `truncated` answers "may more rows match", and a page's size is the slots it spent: the
/// store selects a bounded number of keys, then reads their values in batches, so a replacement
/// (which hard-deletes the row it supersedes) or a retention pass can remove a selected key
/// between the two. `StreamedEvent::Vanished` is the store's own signal for that slot, and a
/// caller that counted the surviving rows would answer `truncated: false` with a matching row
/// still unread — the "silent short page" the page obligation forbids.
#[tokio::test]
async fn a_page_that_lost_a_slot_is_still_marked_truncated() {
    use std::sync::Arc;

    let fixture = TestMcp::start_with_events(
        Fixture::default(),
        Some(Arc::new(
            |backend: Arc<nostream_storage::lmdb::LmdbBackend>| {
                Arc::new(common::VanishingRepository::new(backend, 2)) as Arc<dyn EventRepository>
            },
        )),
    )
    .await;
    let seeded = [event(1, 1, 1_699_999_900), event(2, 1, 1_699_999_901)];
    fixture.seed(&seeded).await;
    let client = fixture.client().await;

    // Both selected slots are the page, and the second one vanished: one row survives, and
    // another row may still match.
    let result = client
        .call(TOOL_LIST_EVENTS, json!({ "kinds": [1], "limit": 2 }))
        .await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let full = payload(&result);
    let events = full["events"].as_array().unwrap();
    assert_eq!(events.len(), 1, "the vanished slot carries no row: {full}");
    assert_eq!(
        full["truncated"], true,
        "two slots were spent, so the page is complete and more may match: {full}"
    );

    // The control: the same page under a bound it does not reach is not truncated, so the
    // marker answers the page's size rather than being always true.
    let result = client
        .call(TOOL_LIST_EVENTS, json!({ "kinds": [1], "limit": 3 }))
        .await;
    let control = payload(&result);
    assert_eq!(control["truncated"], false, "{control}");
}
