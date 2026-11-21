//! AC6–AC8 — the oracle's schema half: the whole `tools/list` document against a committed
//! snapshot.
//!
//! | case | what it proves |
//! |---|---|
//! | `the_tool_list_matches_the_snapshot` | every tool's name, description and `inputSchema`, by whole-document equality |
//! | `the_comparator_rejects_a_changed_list` | the comparator can fail: a removed tool, a changed description and a changed schema each fail through the same `compare` |
//! | `the_required_parameters_are_typed` | the shapes the values fix: an `Option<T>` is a two-element type array, `get_event` carries `id`, `settings_set` names both accepted forms, no schema is empty |
//! | `the_server_version_is_what_the_composition_supplies` | `serverInfo.version` is the composition's, not this crate's |
//! | `initialize_publishes_the_prerequisites` | `initialize`'s `instructions` name the credential, its scopes and the surface's one remaining prerequisite |
//!
//! The snapshot is **name-sorted**, because rmcp sorts the list and array equality is
//! order-sensitive (R21). It is compared, never regenerated: nothing here writes a file.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::TestMcp;
use nostream_mcp::{
    MAX_ROWS_PER_PAGE, TOOL_DELETE_EVENT, TOOL_GET_EVENT, TOOL_INVOICES_GET, TOOL_INVOICES_LIST,
    TOOL_LIST_EVENTS, TOOL_RELAY_STATUS, TOOL_REPORTS_ACTION, TOOL_REPORTS_LIST, TOOL_SETTINGS_GET,
    TOOL_SETTINGS_SET, TOOL_USER_ADMIN, TOOL_USER_GET,
};
use serde_json::{Value, json};

/// The committed snapshot, as a document. A missing fixture fails the case.
fn snapshot() -> Value {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("tools_list.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("the committed snapshot {}: {error}", path.display()));
    serde_json::from_str(&raw).expect("the snapshot is JSON")
}

/// The one comparator both the snapshot case and the tampering case call (R21).
fn compare(actual: &Value, expected: &Value) -> Result<(), String> {
    if actual == expected {
        return Ok(());
    }
    let tools = |document: &Value| {
        document["tools"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![document.clone()])
    };
    let (actual_tools, expected_tools) = (tools(actual), tools(expected));
    for expected_tool in &expected_tools {
        let name = expected_tool["name"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let Some(actual_tool) = actual_tools.iter().find(|tool| tool["name"] == name) else {
            return Err(format!("tool {name} is missing from the list"));
        };
        for field in ["description", "inputSchema", "outputSchema"] {
            if actual_tool[field] != expected_tool[field] {
                return Err(format!("tool {name}: {field} differs"));
            }
        }
        if actual_tool != expected_tool {
            return Err(format!("tool {name}: the document differs"));
        }
    }
    for actual_tool in &actual_tools {
        let name = actual_tool["name"].as_str().unwrap_or_default().to_owned();
        if !expected_tools.iter().any(|tool| tool["name"] == name) {
            return Err(format!("tool {name} is not in the snapshot"));
        }
    }
    Err("the tool list differs".to_owned())
}

#[tokio::test]
async fn the_tool_list_matches_the_snapshot() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;
    let actual = json!({ "tools": client.tools().await });
    compare(&actual, &snapshot()).expect("the tool list equals the committed snapshot");
}

#[tokio::test]
async fn the_comparator_rejects_a_changed_list() {
    let document = snapshot();

    let mut removed = document.clone();
    removed["tools"].as_array_mut().unwrap().pop();
    assert!(compare(&document, &removed).is_err(), "a removed tool");

    let mut description = document.clone();
    description["tools"][0]["description"] =
        Value::String(format!("{} (drifted)", document["tools"][0]["description"]));
    assert!(compare(&description, &document).is_err(), "a description");

    let mut schema = document.clone();
    schema["tools"][1]["inputSchema"]["type"] = json!("array");
    assert!(compare(&schema, &document).is_err(), "a schema `type`");
}

#[tokio::test]
async fn the_required_parameters_are_typed() {
    let document = snapshot();
    let tool = |name: &str| {
        document["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("{name} is in the snapshot"))
            .clone()
    };

    let limit = &tool(TOOL_LIST_EVENTS)["inputSchema"]["properties"]["limit"]["type"];
    let kinds = limit.as_array().expect("an Option is a type array");
    assert_eq!(
        kinds.len(),
        2,
        "an Option is a two-element type array: {limit}"
    );
    assert_eq!(kinds[1], "null", "and its second member is null: {limit}");

    // The page contract the descriptions state, and the schema's own bound.
    let listing = tool(TOOL_LIST_EVENTS);
    let description = listing["description"].as_str().unwrap_or_default();
    assert!(description.contains("oldest first"), "{description}");
    assert!(description.contains("truncated"), "{description}");
    assert_eq!(
        listing["inputSchema"]["properties"]["limit"]["minimum"],
        json!(1),
        "a page of zero rows is not a page: {description}"
    );

    // One number, three readers: the store's no-limit page, the tool's constant and the schema
    // a client validates against cannot drift apart.
    assert_eq!(
        MAX_ROWS_PER_PAGE,
        nostream_storage::DEFAULT_PAGE_ROWS,
        "the tool's page bound is the store's own page, the page `truncated` is derived from"
    );
    assert_eq!(
        listing["inputSchema"]["properties"]["limit"]["maximum"],
        json!(MAX_ROWS_PER_PAGE),
        "the schema's bound is the tool's page bound"
    );

    assert!(
        tool(TOOL_GET_EVENT)["inputSchema"]["properties"]
            .get("id")
            .is_some(),
        "get_event declares `id`"
    );

    let description = tool(TOOL_SETTINGS_SET)["description"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert!(description.contains("path"), "{description}");
    assert!(description.contains("changes"), "{description}");

    for tool in document["tools"].as_array().unwrap() {
        let schema = &tool["inputSchema"];
        assert_ne!(schema, &json!({}), "{} has a schema", tool["name"]);
        assert_eq!(schema["type"], "object", "{}: {schema}", tool["name"]);
    }

    let names: Vec<&str> = document["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec![
            TOOL_DELETE_EVENT,
            TOOL_GET_EVENT,
            TOOL_INVOICES_GET,
            TOOL_INVOICES_LIST,
            TOOL_LIST_EVENTS,
            TOOL_RELAY_STATUS,
            TOOL_REPORTS_ACTION,
            TOOL_REPORTS_LIST,
            TOOL_SETTINGS_GET,
            TOOL_SETTINGS_SET,
            TOOL_USER_ADMIN,
            TOOL_USER_GET
        ],
        "the twelve tools, name-sorted"
    );
}

#[tokio::test]
async fn the_server_version_is_what_the_composition_supplies() {
    let fixture = TestMcp::start().await;
    let client = fixture.client_with_version("9.9.9").await;
    let info = client
        .client
        .peer()
        .peer_info()
        .expect("the initialize result arrived");
    let server = info.server_info.as_ref().expect("the server named itself");
    assert_eq!(server.name, nostream_mcp::MCP_SERVER_NAME);
    assert_eq!(server.version, "9.9.9");
    assert_ne!(server.version, env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn initialize_publishes_the_prerequisites() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;
    let instructions = client
        .client
        .peer()
        .peer_info()
        .and_then(|info| info.instructions.clone())
        .expect("initialize carries instructions");
    for needle in [
        "--admin-token-file",
        "--admin-token-fd",
        "admin.enabled",
        "write",
        "mcp.denied",
        TOOL_RELAY_STATUS,
        TOOL_DELETE_EVENT,
        TOOL_REPORTS_ACTION,
        TOOL_REPORTS_LIST,
        TOOL_USER_ADMIN,
        TOOL_USER_GET,
        TOOL_INVOICES_LIST,
        TOOL_INVOICES_GET,
    ] {
        assert!(
            instructions.contains(needle),
            "the instructions name `{needle}`: {instructions}"
        );
    }
}
