//! AC17 — the page and its assets under a relay prefix: no placeholder left, the scripts under
//! the prefix, the name in the title, one nonce across the header and every `<script>`, an
//! asset byte-identical with a query string, a traversal refused, and no unprefixed surface.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{Fixture, TestServer};

async fn prefixed_server() -> TestServer {
    TestServer::start_with(
        Fixture::default()
            .with(
                "info.relay_url",
                serde_json::json!("wss://relay.example/nostr"),
            )
            .with("info.name", serde_json::json!("Example")),
    )
    .await
}

/// The value of `nonce="…"` on every `<script>` tag of the page.
fn script_nonces(html: &str) -> Vec<String> {
    let mut nonces = Vec::new();
    let mut rest = html;
    while let Some(index) = rest.find("<script") {
        let tag_end = rest[index..]
            .find('>')
            .map(|offset| index + offset)
            .unwrap_or(rest.len());
        let tag = &rest[index..tag_end];
        if let Some(nonce_at) = tag.find("nonce=\"") {
            let value = &tag[nonce_at + "nonce=\"".len()..];
            let end = value.find('"').unwrap_or(value.len());
            nonces.push(value[..end].to_owned());
        }
        rest = &rest[tag_end..];
    }
    nonces
}

#[tokio::test]
async fn the_page_has_no_placeholder_left() {
    let server = prefixed_server().await;
    let response = server.get("/nostr/admin/").await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.content_type(), "text/html; charset=utf8");
    assert!(!response.text().contains("{{"), "no placeholder survives");
}

#[tokio::test]
async fn the_scripts_begin_with_the_prefix() {
    let server = prefixed_server().await;
    let response = server.get("/nostr/admin/").await;
    let html = response.text();
    let mut sources = Vec::new();
    let mut rest = html.as_str();
    while let Some(index) = rest.find("<script src=\"") {
        let value = &rest[index + "<script src=\"".len()..];
        let end = value.find('"').unwrap();
        sources.push(value[..end].to_owned());
        rest = &value[end..];
    }
    assert_eq!(sources.len(), 6, "six scripts: {sources:?}");
    for source in &sources {
        assert!(
            source.starts_with("/nostr/admin/assets/"),
            "the script's src carries the prefix: {source}"
        );
    }
    assert!(html.contains("/nostr/admin/assets/dashboard.css?v=site-6"));
}

#[tokio::test]
async fn the_title_carries_the_name() {
    let server = prefixed_server().await;
    let html = server.get("/nostr/admin/").await.text();
    assert!(
        html.contains("<title>Example Admin</title>"),
        "the name is substituted"
    );
}

#[tokio::test]
async fn the_csp_nonce_matches_every_script() {
    let server = prefixed_server().await;
    let response = server.get("/nostr/admin/").await;
    let policy = response
        .header("content-security-policy")
        .expect("a CSP header")
        .to_owned();
    let html = response.text();
    let nonces = script_nonces(&html);
    assert!(!nonces.is_empty(), "every script carries a nonce");
    let first = nonces[0].clone();
    assert!(
        nonces.iter().all(|nonce| *nonce == first),
        "one nonce per response"
    );
    assert!(
        policy.contains(&format!("'nonce-{first}'")),
        "the header carries the same nonce: {policy}"
    );
    assert!(policy.contains("default-src 'self'"));
    assert!(policy.contains("script-src"));
}

#[tokio::test]
async fn an_asset_is_served_byte_identically_with_a_query_string() {
    let server = prefixed_server().await;
    let response = server
        .get("/nostr/admin/assets/dashboard.css?v=site-6")
        .await;
    assert_eq!(response.status, 200);
    assert_eq!(response.content_type(), "text/css; charset=utf-8");
    let on_disk =
        std::fs::read(common::resources_root().join("admin/assets/dashboard.css")).unwrap();
    assert_eq!(response.body, on_disk);
}

#[tokio::test]
async fn a_traversal_name_is_404() {
    let server = prefixed_server().await;
    for name in [
        "..%2Fdashboard.html",
        "..%2F..%2Fdefault-settings.yaml",
        "%2E%2E%2Fdashboard.html",
        "nope.js",
    ] {
        let response = server.get(&format!("/nostr/admin/assets/{name}")).await;
        assert_eq!(response.status, 404, "{name}: {}", response.status);
    }
}

#[tokio::test]
async fn the_unprefixed_surface_is_404() {
    let server = prefixed_server().await;
    let response = server.get("/admin/session").await;
    assert_eq!(
        response.status,
        404,
        "no prefix, no surface: {}",
        response.text()
    );
}
