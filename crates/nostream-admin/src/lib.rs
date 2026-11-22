//! `nostream-admin` owns the admin HTTP surface: the controllers, the route table, the request
//! wrappers, the authentication and the admin utils.
//!
//! It owns these TypeScript paths from the capture commit
//! (`242a3001d77149e4d70151ec03060c4ef44a1547`), and the tree at `rewrite/main`'s HEAD:
//!
//! - `src/handlers/request-handlers/` — the eight admin middlewares and wrappers
//!   (`admin-enabled-middleware`, `admin-auth-middleware`'s cookie half, `admin-json-body-middleware`,
//!   `admin-rate-limit-middleware`, `with-admin-controller-request-handler`,
//!   `get-admin-dashboard-request-handler`) and, as labelled stubs, the non-admin document
//!   handlers (`get-health`, `get-privacy`, `get-readyz`, `get-terms`, `nodeinfo`, `root`)
//! - `src/controllers/admin/` (all of them) and `src/routes/admin/index.ts` (all 30 routes)
//! - `src/schemas/admin-*.ts`
//! - `src/utils/admin-*.ts` (the settings-family exception, `admin-notifications-settings.ts`,
//!   belongs to `nostream-config`) and the request half of `src/utils/http.ts`
//! - `src/admin/password-admin-auth-provider.ts`
//! - `src/@types/{admin,admin-audit,admin-ops}.ts`
//!
//! **It owns the whole surface now, not a skeleton.** [`routes::mount`] builds an
//! `axum::Router`: the page and its seven assets, the session and login routes, the 26 console
//! API endpoints over 24 paths, the metrics SSE stream, the settings writer, the ops/trust/
//! moderation/diagnostics routes, and the enabled gate and CSP header in front of them. The
//! daemon serves that router from the one listener it binds (D13): this crate never opens a
//! socket.
//!
//! **Deliberately not owned here** — a reader should be able to tell an omission from a gap:
//!
//! - the listening socket, the WebSocket upgrade and the drain — `nostreamd` and
//!   `nostream-relay`;
//! - the settings merge, validation, redaction and the guided catalogue — `nostream-config`
//!   (the *writer* is `nostream-config`'s `store` module, called from here);
//! - the event store, the repositories and the notification channels — `nostream-storage` and
//!   `nostream-services`;
//! - NIP-98 authentication and its replay claim — a later job (D6);
//! - the MCP server — `crates/nostream-mcp`, a separate crate that reuses this one's state,
//!   session credential and audit path — and the CLI, a separate issue;
//! - the app-level connection rate limiter — deliberately not applied to HTTP (D1).

// An axum rejection *is* an `http::Response`, so every extractor's error type is one; the
// alternative the lint suggests (boxing it) would allocate on the rejection path for nothing.
#![allow(clippy::result_large_err)]

pub mod auth;
pub mod controllers;
pub mod error;
pub mod routes;
pub mod state;
pub mod utils;

pub use error::AdminError;
pub use routes::{ADMIN_ROUTES, AdminRoute, PREFIX_MIDDLEWARE, mount};
pub use state::{AdminState, AdminStateConfig, GrafanaSettings, MaintenanceRun};

/// The CSP nonce the page's `<script>` tags carry, for a caller that mounts the page itself.
pub use controllers::admin_enabled_middleware::Nonce;
pub use controllers::admin_rate_limit_middleware::{AdminRateLimited, LoginRateLimited};

/// Serves one already-accepted connection's peer address to the extractors.
///
/// The daemon serves each HTTP connection itself (D13), so nothing inserted axum's
/// `ConnectInfo` for it; this layer does, which is what makes `limits.admin.ipWhitelist` and
/// the trusted-proxy rules work on the real path as they do under `axum::serve`.
pub fn with_peer_address(router: axum::Router, peer: std::net::SocketAddr) -> axum::Router {
    use axum::extract::{ConnectInfo, Request};
    use axum::middleware::Next;
    use axum::response::Response;

    router.layer(axum::middleware::from_fn(
        move |mut request: Request, next: Next| async move {
            request.extensions_mut().insert(ConnectInfo(peer));
            let response: Response = next.run(request).await;
            response
        },
    ))
}
