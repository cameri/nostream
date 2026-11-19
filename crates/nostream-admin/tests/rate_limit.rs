//! AC12 — the two admin limiters, over the tree's shared limiter. Mirrors
//! `src/handlers/request-handlers/admin-rate-limit-middleware.ts` and
//! `src/utils/admin-rate-limit.ts` (Values 4, 5, 6, 48) and runs the store
//! `limits.rateLimiter.strategy` selects (D14), EWMA by default.
//!
//! The arithmetic AC12 asserts, at the shipped settings (admin 30 per 60,000 ms, login 10 per
//! 900,000 ms) with `TestClock` held still: EWMA adds `step` to a rate that decays, and refuses
//! when `rate > limit`, so `n` hits at one instant leave `rate = n` and the **31st** admin hit
//! (rate 31) and the **11th** login hit (rate 11) are the first refusals. A refusal stores the
//! new rate before the verdict, so it advances the key; the key expires after
//! `ceil(period / 1000)` s and the next hit starts from zero.

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
async fn the_thirty_first_admin_request_is_429_under_ewma() {
    let server = TestServer::start_with(limiter_fixture()).await;

    for attempt in 1..=30 {
        let response = server.get("/admin/session").await;
        assert_eq!(response.status, 401, "attempt {attempt} before the limit");
    }

    let limited = server.get("/admin/session").await;
    assert_eq!(limited.status, 429, "the 31st request");
    assert_eq!(limited.json()["error"], "Too many requests");

    // The key's TTL is `ceil(60,000 / 1000)` s, so a minute later it is gone and the next hit
    // starts from zero (EWMA's expiry, not a sliding window's).
    common::advance(&server.clock, 60_001);
    let after = server.get("/admin/session").await;
    assert_eq!(after.status, 401, "the key expired");
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

/// The refusal rule and the TTL, at the limiter the surface runs: a refused hit still shapes
/// the key, and a key past its TTL is gone.
#[test]
fn a_refused_hit_advances_the_rate_and_a_stale_key_starts_fresh() {
    use nostream_core::clock::TestClock;
    use nostream_relay::limits::{EwmaRateLimiter, RateLimitConfig};

    let clock = std::sync::Arc::new(TestClock::new(1_700_000_000_000));
    let limiter = EwmaRateLimiter::new(clock.clone());
    let config = RateLimitConfig {
        period_ms: 60_000,
        rate: 30,
    };

    for hit in 1..=30 {
        assert!(
            !limiter.hit("key", 1, &config).unwrap(),
            "hit {hit} is inside the rate"
        );
    }
    // rate = 30 after thirty hits at one instant; `30 > 30` is false.
    assert_eq!(limiter.rate("key", &config), Some(30.0));

    // The 31st: rate becomes 31 and the verdict is taken on the new rate.
    assert!(limiter.hit("key", 1, &config).unwrap(), "the 31st hit");
    assert_eq!(
        limiter.rate("key", &config),
        Some(31.0),
        "the refusal is stored before the verdict, as the capture's Lua does"
    );

    // A full TTL later (ceil(60,000 / 1000) s) the key is gone and a hit starts from zero.
    clock.advance(60_001);
    assert_eq!(limiter.rate("key", &config), None, "the key expired");
    assert!(!limiter.hit("key", 1, &config).unwrap());
    assert_eq!(limiter.rate("key", &config), Some(1.0));
}

/// The strategy switch is live: at 59 s the EWMA rate has decayed below the limit while the
/// sliding window still holds its thirty hits, so the same request is admitted by one and
/// refused by the other.
#[tokio::test]
async fn the_settings_select_the_strategy() {
    let (ewma, sliding) = (
        TestServer::start_with(limiter_fixture()).await,
        TestServer::start_with(limiter_fixture().with(
            "limits.rateLimiter.strategy",
            serde_json::json!("sliding_window"),
        ))
        .await,
    );

    for server in [&ewma, &sliding] {
        for _ in 0..30 {
            assert_eq!(server.get("/admin/session").await.status, 401);
        }
    }

    // 30·2^(-59/60) ≈ 15.18, plus 1, is inside the rate of 30 for EWMA; the sliding window
    // still carries all thirty hits, so 30 + 1 > 30 refuses.
    for server in [&ewma, &sliding] {
        common::advance(&server.clock, 59_000);
    }
    assert_eq!(
        ewma.get("/admin/session").await.status,
        401,
        "the EWMA rate decayed below the limit"
    );
    assert_eq!(
        sliding.get("/admin/session").await.status,
        429,
        "the sliding window still holds all thirty hits"
    );
}
