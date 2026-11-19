//! AC12 — the two admin limiters. Mirrors
//! `src/handlers/request-handlers/admin-rate-limit-middleware.ts` and
//! `src/utils/admin-rate-limit.ts` (Values 4, 5, 6, 48).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{Fixture, PASSWORD, TestServer};

fn limiter_fixture() -> Fixture {
    let fixture = Fixture {
        settings: common::settings_with_limiters(),
        ..Fixture::default()
    };
    // The shipped whitelist names `::1`; this client is `127.0.0.1`, which must not be
    // whitelisted for the limit to be reachable.
    fixture.with("limits.admin.ipWhitelist", serde_json::json!([]))
}

#[tokio::test]
async fn the_thirty_first_admin_request_is_429() {
    let server = TestServer::start_with(limiter_fixture()).await;

    for attempt in 1..=30 {
        let response = server.get("/admin/session").await;
        assert_eq!(response.status, 401, "attempt {attempt} before the limit");
    }

    let limited = server.get("/admin/session").await;
    assert_eq!(limited.status, 429, "the 31st request");
    assert_eq!(limited.json()["error"], "Too many requests");

    // The window slides: a minute later the counter is empty again.
    common::advance(&server.clock, 60_001);
    let after = server.get("/admin/session").await;
    assert_eq!(after.status, 401, "the window slid");
}

#[tokio::test]
async fn the_eleventh_login_attempt_is_429() {
    let server = TestServer::start_with(limiter_fixture()).await;
    let body = format!("{{\"password\":\"{PASSWORD}\"}}");

    for attempt in 1..=10 {
        let response = server
            .request(
                "POST",
                "/admin/login",
                &[("content-type", "application/json")],
                Some(body.as_bytes()),
            )
            .await;
        assert_eq!(response.status, 200, "attempt {attempt}");
    }

    let limited = server
        .request(
            "POST",
            "/admin/login",
            &[("content-type", "application/json")],
            Some(body.as_bytes()),
        )
        .await;
    assert_eq!(limited.status, 429, "the 11th login");
    assert_eq!(limited.json()["error"], "Too many requests");
}

#[tokio::test]
async fn a_whitelisted_address_trips_neither() {
    let server = TestServer::start_with(
        limiter_fixture().with("limits.admin.ipWhitelist", serde_json::json!(["127.0.0.1"])),
    )
    .await;
    let body = format!("{{\"password\":\"{PASSWORD}\"}}");

    for _ in 0..50 {
        let response = server.get("/admin/session").await;
        assert_eq!(
            response.status, 401,
            "the whitelist bypasses the admin limiter"
        );
    }
    for _ in 0..15 {
        let response = server
            .request(
                "POST",
                "/admin/login",
                &[("content-type", "application/json")],
                Some(body.as_bytes()),
            )
            .await;
        assert_eq!(
            response.status, 200,
            "the whitelist bypasses the login limiter"
        );
    }
}

#[tokio::test]
async fn the_two_scopes_do_not_share_a_counter() {
    let server = TestServer::start_with(limiter_fixture()).await;
    let wrong = b"{\"password\":\"wrong\"}";

    for _ in 0..10 {
        let response = server
            .request(
                "POST",
                "/admin/login",
                &[("content-type", "application/json")],
                Some(wrong),
            )
            .await;
        assert_eq!(response.status, 401);
    }

    // Ten login hits must not consume the admin limiter's thirty.
    for attempt in 1..=30 {
        let response = server.get("/admin/session").await;
        assert_eq!(
            response.status, 401,
            "admin attempt {attempt} after ten logins"
        );
    }
    assert_eq!(server.get("/admin/session").await.status, 429);
}
