//! AC21 — unauthenticated calls are refused, four ways, without touching the environment.
//!
//! | case | what it proves |
//! |---|---|
//! | `no_token_refuses_every_tool` | a server built with no token refuses all four tools with `Unauthorized`, and still lists them |
//! | `an_expired_token_is_refused` | a token that expired one second ago is `Unauthorized` |
//! | `a_disabled_surface_is_refused` | `admin.enabled: false` answers `Not Found`, as the console does |
//! | `a_missing_secret_is_refused` | no `SECRET` answers `Internal Server Error` |
//!
//! Each case builds its own server with the token as a **value**, and none sets an environment
//! variable: four cases in one binary run in parallel, so an environment-based gate would race.
//! The three texts are distinct on purpose — a gate that collapsed them could pass a case
//! written against the wrong arm.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{Fixture, TestMcp, Token, text};
use nostream_mcp::{INTERNAL_SERVER_ERROR, NOT_FOUND, TOOL_GET_EVENT, UNAUTHORIZED};
use serde_json::json;

/// The four tools, each with arguments its schema accepts, so the refusal cannot be a
/// deserialisation failure in disguise.
fn calls() -> [(&'static str, serde_json::Value); 4] {
    [
        (nostream_mcp::TOOL_SETTINGS_GET, json!({})),
        (
            nostream_mcp::TOOL_SETTINGS_SET,
            json!({ "path": "wot.enabled", "value": true }),
        ),
        (nostream_mcp::TOOL_LIST_EVENTS, json!({ "kinds": [1] })),
        (TOOL_GET_EVENT, json!({ "id": "00".repeat(32) })),
    ]
}

#[tokio::test]
async fn no_token_refuses_every_tool() {
    let fixture = TestMcp::start_with(Fixture {
        token: Token::Absent,
        ..Fixture::default()
    })
    .await;
    let client = fixture.client().await;

    assert_eq!(client.tools().await.len(), 4, "tools/list is not gated");
    for (tool, arguments) in calls() {
        let result = client.call(tool, arguments).await;
        assert_eq!(result.is_error, Some(true), "{tool}");
        assert_eq!(text(&result), UNAUTHORIZED, "{tool}");
    }
    assert!(
        fixture.audit_entries().is_empty(),
        "a refusal writes nothing"
    );
}

#[tokio::test]
async fn an_expired_token_is_refused() {
    let fixture = TestMcp::start_with(Fixture {
        token: Token::Expired,
        ..Fixture::default()
    })
    .await;
    let client = fixture.client().await;

    let result = client
        .call(nostream_mcp::TOOL_SETTINGS_GET, json!({}))
        .await;
    assert_eq!(result.is_error, Some(true));
    assert_eq!(text(&result), UNAUTHORIZED);
    assert!(fixture.audit_entries().is_empty());
}

#[tokio::test]
async fn a_disabled_surface_is_refused() {
    let fixture = TestMcp::start_with(Fixture::default().with("admin.enabled", json!(false))).await;
    let client = fixture.client().await;

    let result = client
        .call(nostream_mcp::TOOL_SETTINGS_GET, json!({}))
        .await;
    assert_eq!(result.is_error, Some(true));
    assert_eq!(text(&result), NOT_FOUND);
    assert!(fixture.audit_entries().is_empty());
}

#[tokio::test]
async fn a_missing_secret_is_refused() {
    let fixture = TestMcp::start_with(Fixture {
        secret: None,
        ..Fixture::default()
    })
    .await;
    let client = fixture.client().await;

    let result = client
        .call(nostream_mcp::TOOL_SETTINGS_GET, json!({}))
        .await;
    assert_eq!(result.is_error, Some(true));
    assert_eq!(text(&result), INTERNAL_SERVER_ERROR);
    assert!(fixture.audit_entries().is_empty());
}
