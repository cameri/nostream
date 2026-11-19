//! AC11 — the capture's stateless session model, byte for byte: the token shape, the clock,
//! the password rules, the cookie and its `Secure` flag.
//!
//! | case | Value |
//! |---|---|
//! | `an_expired_token_is_rejected` | 2, 8 |
//! | `a_wrong_signature_is_rejected` | 8 |
//! | `a_bearer_token_is_accepted_without_a_cookie` | 8 |
//! | `the_ttl_falls_back_to_86400` | 2 |
//! | `a_fixture_scrypt_hash_verifies_and_a_wrong_password_does_not` | 9, 36 |
//! | `admin_password_overrides_the_hash` | 10 |
//! | `the_cookie_path_follows_the_relay_prefix` | 7 |
//! | `a_secure_request_marks_the_cookie_secure` | 49 |

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{Fixture, PASSWORD, TestServer};
use nostream_admin::utils::session;

fn login_body(password: &str) -> Vec<u8> {
    format!("{{\"password\":\"{password}\"}}").into_bytes()
}

#[tokio::test]
async fn an_expired_token_is_rejected() {
    let server = TestServer::start_with(
        Fixture::default().with("admin.sessionTtlSeconds", serde_json::json!(60)),
    )
    .await;
    let cookie = server.login().await;

    let fresh = server.get_with("/admin/session", &cookie).await;
    assert_eq!(fresh.status, 200, "{}", fresh.text());

    common::advance(&server.clock, 61_000);

    let expired = server.get_with("/admin/session", &cookie).await;
    assert_eq!(expired.status, 401, "{}", expired.text());
    assert_eq!(expired.json()["error"], "Unauthorized");
}

#[tokio::test]
async fn a_wrong_signature_is_rejected() {
    let server = TestServer::start().await;
    let key = session::session_key(b"another-secret");
    let token = session::create_token(&key, common::now_seconds(&server.clock) + 60);

    let response = server
        .request(
            "GET",
            "/admin/session",
            &[("cookie", &format!("admin_session={token}"))],
            None,
        )
        .await;
    assert_eq!(response.status, 401, "{}", response.text());

    // A signature of the wrong length is rejected too, not sliced into a match.
    let short = format!("{}.deadbeef", common::now_seconds(&server.clock) + 60);
    let response = server
        .request(
            "GET",
            "/admin/session",
            &[("cookie", &format!("admin_session={short}"))],
            None,
        )
        .await;
    assert_eq!(response.status, 401);
}

#[tokio::test]
async fn a_bearer_token_is_accepted_without_a_cookie() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let token = cookie.trim_start_matches("admin_session=").to_owned();

    let response = server
        .request(
            "GET",
            "/admin/session",
            &[("authorization", &format!("Bearer {token}"))],
            None,
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.json()["authenticated"], true);
}

#[tokio::test]
async fn the_ttl_falls_back_to_86400() {
    let server = TestServer::start_with(
        Fixture::default().with("admin.sessionTtlSeconds", serde_json::json!(0)),
    )
    .await;
    let response = server
        .request(
            "POST",
            "/admin/login",
            &[("content-type", "application/json")],
            Some(&login_body(PASSWORD)),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let cookie = response.header("set-cookie").unwrap();
    assert!(
        cookie.contains("Max-Age=86400"),
        "the default TTL is a day: {cookie}"
    );

    let expected = common::now_seconds(&server.clock) + 86_400;
    assert_eq!(response.json()["expiresAt"], expected);
}

#[tokio::test]
async fn a_fixture_scrypt_hash_verifies_and_a_wrong_password_does_not() {
    let server = TestServer::start().await;

    let ok = server
        .request(
            "POST",
            "/admin/login",
            &[("content-type", "application/json")],
            Some(&login_body(PASSWORD)),
        )
        .await;
    assert_eq!(ok.status, 200, "{}", ok.text());
    assert_eq!(ok.json()["authenticated"], true);
    let cookie = ok.header("set-cookie").expect("a cookie");
    assert!(cookie.starts_with("admin_session="));
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Strict"));
    assert!(
        !cookie.contains("Secure"),
        "plain HTTP is not secure: {cookie}"
    );

    let rejected = server
        .request(
            "POST",
            "/admin/login",
            &[("content-type", "application/json")],
            Some(&login_body("hunter3")),
        )
        .await;
    assert_eq!(rejected.status, 401);
    assert_eq!(rejected.json()["error"], "Unauthorized");
    assert!(rejected.header("set-cookie").is_none());
}

#[tokio::test]
async fn admin_password_overrides_the_hash() {
    let fixture = Fixture {
        password_override: Some("plain-text".to_owned()),
        ..Fixture::default()
    };
    let server = TestServer::start_with(fixture).await;

    let override_login = server
        .request(
            "POST",
            "/admin/login",
            &[("content-type", "application/json")],
            Some(&login_body("plain-text")),
        )
        .await;
    assert_eq!(override_login.status, 200, "{}", override_login.text());

    let hash_password = server
        .request(
            "POST",
            "/admin/login",
            &[("content-type", "application/json")],
            Some(&login_body(PASSWORD)),
        )
        .await;
    assert_eq!(hash_password.status, 401, "the override wins over the hash");
}

#[tokio::test]
async fn the_cookie_path_follows_the_relay_prefix() {
    let server = TestServer::start_with(Fixture::default().with(
        "info.relay_url",
        serde_json::json!("wss://relay.example/nostr"),
    ))
    .await;

    // The surface is mounted under the prefix, so the login route moved with it.
    let login = server
        .request(
            "POST",
            "/nostr/admin/login",
            &[("content-type", "application/json")],
            Some(&login_body(PASSWORD)),
        )
        .await;
    assert_eq!(login.status, 200, "{}", login.text());
    let cookie = login.header("set-cookie").expect("a cookie");
    assert!(cookie.contains("Path=/nostr/admin"), "{cookie}");

    // And the unprefixed login is not a route at all.
    let unprefixed = server
        .request(
            "POST",
            "/admin/login",
            &[("content-type", "application/json")],
            Some(&login_body(PASSWORD)),
        )
        .await;
    assert_eq!(unprefixed.status, 404, "{}", unprefixed.text());
}

#[tokio::test]
async fn a_secure_request_marks_the_cookie_secure() {
    let server = TestServer::start_with(
        Fixture::default()
            .with("network.trustedProxies", serde_json::json!(["127.0.0.1"]))
            .with(
                "network.remoteIpHeader",
                serde_json::json!("x-forwarded-for"),
            ),
    )
    .await;

    let trusted = server
        .request(
            "POST",
            "/admin/login",
            &[
                ("content-type", "application/json"),
                ("x-forwarded-proto", "https"),
            ],
            Some(&login_body(PASSWORD)),
        )
        .await;
    assert_eq!(trusted.status, 200, "{}", trusted.text());
    assert!(
        trusted.header("set-cookie").unwrap().contains("; Secure"),
        "a trusted proxy's https marks the cookie Secure: {:?}",
        trusted.header("set-cookie")
    );

    let untrusted_proto = server
        .request(
            "POST",
            "/admin/login",
            &[
                ("content-type", "application/json"),
                ("x-forwarded-proto", "http"),
            ],
            Some(&login_body(PASSWORD)),
        )
        .await;
    assert_eq!(untrusted_proto.status, 200);
    assert!(
        !untrusted_proto
            .header("set-cookie")
            .unwrap()
            .contains("Secure")
    );
}
