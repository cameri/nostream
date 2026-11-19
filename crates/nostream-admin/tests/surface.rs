//! AC10 — the disabled surface answers `404 text/plain "Not Found"` on every admin route.
//! Mirrors `src/handlers/request-handlers/admin-enabled-middleware.ts:5-12` (Value 1).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{Fixture, TestServer};

#[tokio::test]
async fn admin_disabled_answers_not_found_on_every_route() {
    let server =
        TestServer::start_with(Fixture::default().with("admin.enabled", serde_json::json!(false)))
            .await;

    for (method, path) in [
        ("GET", "/admin/"),
        ("GET", "/admin/assets/dashboard.js"),
        ("GET", "/admin/settings"),
        ("POST", "/admin/login"),
        ("GET", "/admin/session"),
        ("PATCH", "/admin/settings"),
        ("GET", "/admin/ops/workers"),
        ("GET", "/admin/metrics"),
    ] {
        let body = (method == "POST" || method == "PATCH").then_some(b"{}".as_slice());
        let response = server
            .request(method, path, &[("content-type", "application/json")], body)
            .await;
        assert_eq!(response.status, 404, "{method} {path}: {}", response.text());
        assert_eq!(
            response.content_type(),
            "text/plain",
            "{method} {path} content type"
        );
        assert_eq!(response.text(), "Not Found", "{method} {path} body");
    }
}
