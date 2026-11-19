//! The surface gate and the security header. Mirrors
//! `src/handlers/request-handlers/admin-enabled-middleware.ts` and the header half of
//! `src/factories/web-app-factory.ts`.
//!
//! The gate is the outermost layer: `admin.enabled != true` answers `404 text/plain "Not Found"`
//! for the page, the assets and every API route. The header layer mints the per-request CSP
//! nonce, hands it to the page controller and stamps the same value into the
//! `Content-Security-Policy` of every admin response.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;

use crate::controllers::request_context::not_found;
use crate::state::AdminState;

/// The CSP directive map's order and shape, from `src/factories/web-app-factory.ts:25-45`.
fn content_security_policy(nonce: &str, relay_url: &str, grafana_origin: &str) -> String {
    let nonce = nonce_directive(nonce);
    let relay_origin = public_origin(relay_url);
    let directives: [(&str, Vec<String>); 8] = [
        (
            "img-src",
            vec![
                "'self'".to_owned(),
                "data:".to_owned(),
                "https://cdn.zebedee.io/an/nostr/".to_owned(),
            ],
        ),
        (
            "connect-src",
            vec!["'self'".to_owned(), relay_url.to_owned(), relay_origin],
        ),
        ("default-src", vec!["'self'".to_owned()]),
        (
            "frame-src",
            vec!["'self'".to_owned(), grafana_origin.to_owned()],
        ),
        ("script-src-attr", vec![nonce.clone()]),
        (
            "script-src",
            vec![
                "'self'".to_owned(),
                nonce,
                "https://cdn.jsdelivr.net/npm/".to_owned(),
                "https://unpkg.com/".to_owned(),
                "https://cdnjs.cloudflare.com/ajax/libs/".to_owned(),
            ],
        ),
        (
            "style-src",
            vec![
                "'self'".to_owned(),
                "https://cdn.jsdelivr.net/npm/".to_owned(),
            ],
        ),
        (
            "font-src",
            vec![
                "'self'".to_owned(),
                "https://cdn.jsdelivr.net/npm/".to_owned(),
            ],
        ),
    ];
    directives
        .iter()
        .map(|(name, values)| format!("{name} {}", values.join(" ")))
        .collect::<Vec<String>>()
        .join("; ")
}

fn nonce_directive(nonce: &str) -> String {
    format!("'nonce-{nonce}'")
}

/// The relay URL with its protocol swapped for the browser's (`getWebProtocolForRelay`).
fn public_origin(relay_url: &str) -> String {
    match relay_url.find("://") {
        Some(index) => {
            let scheme = &relay_url[..index];
            let rest = &relay_url[index + 3..];
            let host_end = rest.find('/').unwrap_or(rest.len());
            let web_scheme = if scheme == "wss" { "https" } else { "http" };
            format!("{web_scheme}://{}", &rest[..host_end])
        }
        None => relay_url.to_owned(),
    }
}

/// The layer that answers `404 Not Found` while `admin.enabled` is not true.
pub async fn admin_enabled(
    State(state): State<Arc<AdminState>>,
    request: Request,
    next: Next,
) -> Response {
    let enabled = state
        .settings()
        .ok()
        .and_then(|settings| settings.admin.map(|admin| admin.enabled))
        .unwrap_or(false);
    if !enabled {
        return not_found();
    }
    next.run(request).await
}

/// The layer that mints the CSP nonce, publishes it as a request extension and stamps the
/// header on every response.
pub async fn content_security(
    State(state): State<Arc<AdminState>>,
    mut request: Request,
    next: Next,
) -> Response {
    let nonce = state
        .random()
        .bytes(16)
        .map(|bytes| {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(bytes)
        })
        .unwrap_or_default();

    request.extensions_mut().insert(Nonce(nonce.clone()));

    let relay_url = state
        .settings()
        .map(|settings| settings.info.relay_url)
        .unwrap_or_default();
    let grafana_origin = crate::utils::grafana::frame_origin(state.grafana());

    let mut response = next.run(request).await;
    let policy = content_security_policy(&nonce, &relay_url, &grafana_origin);
    if let Ok(value) = HeaderValue::from_str(&policy) {
        response
            .headers_mut()
            .insert(HeaderName::from_static("content-security-policy"), value);
    }
    response
}

/// The per-request CSP nonce the page's `<script>` tags carry.
#[derive(Debug, Clone)]
pub struct Nonce(pub String);

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn the_header_carries_the_nonce_and_the_capture_s_directives() {
        let policy = content_security_policy(
            "abc123",
            "wss://relay.example/nostr",
            "http://127.0.0.1:7777",
        );
        assert!(policy.contains("script-src 'self' 'nonce-abc123' https://cdn.jsdelivr.net/npm/"));
        assert!(policy.contains("default-src 'self'"));
        assert!(
            policy.contains("connect-src 'self' wss://relay.example/nostr https://relay.example")
        );
        assert!(policy.contains("frame-src 'self' http://127.0.0.1:7777"));
        assert!(!policy.ends_with("; "));
    }
}
