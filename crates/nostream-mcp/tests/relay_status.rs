//! AC3 — the `relay_status` oracle: the payload's two sources, the null-with-reason rule, and
//! the version's provenance, through the protocol a client uses.
//!
//! | case | what it proves |
//! |---|---|
//! | `a_published_document_is_reported` | a fresh document's four facts arrive, with `reason: null` |
//! | `no_document_reports_nothing_but_the_version_and_the_document` | no file: five nulls and a reason naming it, never a `0` |
//! | `a_stale_document_is_not_a_current_one` | 31 s old is not a fact about the relay |
//! | `a_corrupt_document_is_reported_not_guessed` | a wrong-typed key is a reason, not a panic or an error result |
//! | `a_zero_from_the_document_is_a_number` | a document that says `0` is reported as `0` |
//! | `the_document_is_read_at_call_time` | nothing is cached at start |
//! | `every_call_appends_its_dispatch_line` | one `mcp.relay_status` line, written before the handler |
//! | `a_read_only_document_can_read_the_status` | the row is `Requires::Read` |
//!
//! The harness clock is [`NOW_MS`], so a document generated at that instant is `ageSeconds: 0`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::path::Path;

use common::{Fixture, Grant, TestMcp, payload, text};
use nostream_mcp::TOOL_RELAY_STATUS;
use serde_json::{Value, json};

/// `NOW_MS` as the document's `generatedAt`.
const GENERATED_AT: &str = "2023-11-14T22:13:20.000Z";

/// The five facts only the relay process can know, in the payload's order.
const PUBLISHED: [&str; 5] = [
    "observedAt",
    "ageSeconds",
    "uptimeSeconds",
    "activeConnections",
    "workers",
];

fn write_document(
    config_dir: &Path,
    generated_at: &str,
    uptime_seconds: u64,
    active_connections: u64,
    workers: Value,
) {
    let document = json!({
        "generatedAt": generated_at,
        "uptimeSeconds": uptime_seconds,
        "activeConnections": active_connections,
        "workers": workers,
    });

    std::fs::write(config_dir.join("relay-status.json"), document.to_string())
        .expect("the document is written");
}

fn maintenance_row() -> Value {
    json!([{
        "type": "maintenance",
        "enabled": true,
        "label": "Maintenance",
        "monitored": true,
        "stale": false,
    }])
}

#[tokio::test]
async fn a_published_document_is_reported() {
    let fixture = TestMcp::start().await;
    write_document(
        &fixture.config_dir,
        GENERATED_AT,
        4_242,
        7,
        maintenance_row(),
    );
    let client = fixture.client().await;

    let result = client.call(TOOL_RELAY_STATUS, json!({})).await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let payload = payload(&result);

    assert_eq!(payload["relay"]["reason"], Value::Null);
    assert_eq!(payload["relay"]["uptimeSeconds"], json!(4_242));
    assert_eq!(payload["relay"]["activeConnections"], json!(7));
    assert_eq!(payload["relay"]["observedAt"], json!(GENERATED_AT));
    assert_eq!(payload["relay"]["ageSeconds"], json!(0));
    assert_eq!(payload["relay"]["workers"][0]["type"], json!("maintenance"));
}

#[tokio::test]
async fn no_document_reports_nothing_but_the_version_and_the_document() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let result = client.call(TOOL_RELAY_STATUS, json!({})).await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let payload = payload(&result);

    for key in PUBLISHED {
        assert_eq!(payload["relay"][key], Value::Null, "{key} is null");
    }
    assert!(
        !payload["relay"]["activeConnections"].is_number(),
        "a 0 would read as \"nothing is connected\": {payload}"
    );
    let reason = payload["relay"]["reason"]
        .as_str()
        .expect("the payload says why");
    assert!(reason.contains("relay-status.json"), "{reason}");
    assert_eq!(payload["version"], json!(env!("CARGO_PKG_VERSION")));
    assert_eq!(payload["nip11"]["name"], json!("Example"));
}

#[tokio::test]
async fn a_stale_document_is_not_a_current_one() {
    let fixture = TestMcp::start().await;
    write_document(
        &fixture.config_dir,
        GENERATED_AT,
        4_242,
        7,
        maintenance_row(),
    );
    fixture.clock.advance(31_000);
    let client = fixture.client().await;

    let result = client.call(TOOL_RELAY_STATUS, json!({})).await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let payload = payload(&result);

    for key in PUBLISHED {
        assert_eq!(payload["relay"][key], Value::Null, "{key} is null");
    }
    let reason = payload["relay"]["reason"]
        .as_str()
        .expect("the payload says why");
    assert!(reason.contains("relay-status.json"), "{reason}");
}

#[tokio::test]
async fn a_corrupt_document_is_reported_not_guessed() {
    let fixture = TestMcp::start().await;
    std::fs::write(
        fixture.config_dir.join("relay-status.json"),
        r#"{"activeConnections": "seven"}"#,
    )
    .expect("a written file");
    let client = fixture.client().await;

    let result = client.call(TOOL_RELAY_STATUS, json!({})).await;
    assert_eq!(
        result.is_error,
        Some(false),
        "a document nobody can read is a reason, not a failure: {}",
        text(&result)
    );
    let payload = payload(&result);

    for key in PUBLISHED {
        assert_eq!(payload["relay"][key], Value::Null, "{key} is null");
    }
    assert!(payload["relay"]["reason"].is_string(), "{payload}");
}

#[tokio::test]
async fn a_zero_from_the_document_is_a_number() {
    let fixture = TestMcp::start().await;
    write_document(&fixture.config_dir, GENERATED_AT, 0, 0, json!([]));
    let client = fixture.client().await;

    let result = client.call(TOOL_RELAY_STATUS, json!({})).await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let payload = payload(&result);

    assert_eq!(
        payload["relay"]["activeConnections"],
        json!(0),
        "the document says zero, so the payload does: {payload}"
    );
    assert_eq!(payload["relay"]["ageSeconds"], json!(0));
    assert!(payload["relay"]["activeConnections"].is_number());
}

#[tokio::test]
async fn the_document_is_read_at_call_time() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let before = payload(&client.call(TOOL_RELAY_STATUS, json!({})).await);
    assert_eq!(before["relay"]["activeConnections"], Value::Null);

    write_document(
        &fixture.config_dir,
        GENERATED_AT,
        4_242,
        7,
        maintenance_row(),
    );

    let after = payload(&client.call(TOOL_RELAY_STATUS, json!({})).await);
    assert_eq!(
        after["relay"]["uptimeSeconds"],
        json!(4_242),
        "nothing was cached at start: {after}"
    );
    assert_eq!(after["relay"]["reason"], Value::Null);
}

#[tokio::test]
async fn every_call_appends_its_dispatch_line() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    client.call(TOOL_RELAY_STATUS, json!({})).await;

    let entries = fixture.audit_entries();
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0]["action"], json!("mcp.relay_status"));
    assert_eq!(entries[0]["detail"]["tool"], json!("relay_status"));
    assert!(
        entries[0].get("remoteAddress").is_none(),
        "a stdio caller has no address: {}",
        entries[0]
    );
}

#[tokio::test]
async fn a_read_only_document_can_read_the_status() {
    let fixture = TestMcp::start_with(Fixture {
        grant: Grant::Read,
        ..Fixture::default()
    })
    .await;
    let client = fixture.client().await;

    let result = client.call(TOOL_RELAY_STATUS, json!({})).await;

    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    assert!(payload(&result)["relay"]["reason"].is_string());
}
