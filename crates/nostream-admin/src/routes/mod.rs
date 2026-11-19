//! The admin route table and the router. Mirrors `src/routes/admin/index.ts` at the capture.
//!
//! `ADMIN_ROUTES` is the thirty routes that file registers, in registration order — the
//! console calls twenty-eight of them (`GET /health` and `PATCH /moderation/limits` are
//! registered but unread by its JavaScript, Value 50). `mount` puts the table on an
//! `axum::Router` under `<prefix>/admin`, where the prefix is `info.relay_url`'s path (D10).

use std::sync::Arc;

use axum::Router;
use axum::middleware;
use axum::routing::{get, patch, post};

use crate::controllers;
use crate::state::AdminState;

/// One route of the admin API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminRoute {
    pub method: &'static str,
    pub path: &'static str,
}

/// The `router.use` middlewares and the static mount that precede the table
/// (`rateLimiterMiddleware`, `adminEnabledMiddleware`, `/assets` static files).
pub const PREFIX_MIDDLEWARE: [&str; 3] = [
    "rateLimiterMiddleware",
    "adminEnabledMiddleware",
    "/assets (static)",
];

/// The table, in the order the capture registers them (`src/routes/admin/index.ts:49-221`).
pub const ADMIN_ROUTES: [AdminRoute; 30] = [
    AdminRoute {
        method: "GET",
        path: "/",
    },
    AdminRoute {
        method: "GET",
        path: "/dashboard",
    },
    AdminRoute {
        method: "POST",
        path: "/login",
    },
    AdminRoute {
        method: "POST",
        path: "/logout",
    },
    AdminRoute {
        method: "GET",
        path: "/session",
    },
    AdminRoute {
        method: "GET",
        path: "/health",
    },
    AdminRoute {
        method: "GET",
        path: "/metrics",
    },
    AdminRoute {
        method: "GET",
        path: "/network-health",
    },
    AdminRoute {
        method: "GET",
        path: "/network-health/history",
    },
    AdminRoute {
        method: "POST",
        path: "/network-health/run",
    },
    AdminRoute {
        method: "GET",
        path: "/audit-log",
    },
    AdminRoute {
        method: "GET",
        path: "/diagnostics/export",
    },
    AdminRoute {
        method: "GET",
        path: "/moderation/limits",
    },
    AdminRoute {
        method: "PATCH",
        path: "/moderation/limits",
    },
    AdminRoute {
        method: "POST",
        path: "/moderation/actions",
    },
    AdminRoute {
        method: "GET",
        path: "/moderation/stats",
    },
    AdminRoute {
        method: "GET",
        path: "/settings",
    },
    AdminRoute {
        method: "GET",
        path: "/settings/backups",
    },
    AdminRoute {
        method: "GET",
        path: "/settings/schema",
    },
    AdminRoute {
        method: "PATCH",
        path: "/settings",
    },
    AdminRoute {
        method: "POST",
        path: "/settings/validate",
    },
    AdminRoute {
        method: "POST",
        path: "/settings/restore",
    },
    AdminRoute {
        method: "GET",
        path: "/notifications",
    },
    AdminRoute {
        method: "PATCH",
        path: "/notifications",
    },
    AdminRoute {
        method: "GET",
        path: "/notifications/deliveries",
    },
    AdminRoute {
        method: "POST",
        path: "/notifications/test",
    },
    AdminRoute {
        method: "GET",
        path: "/ops/workers",
    },
    AdminRoute {
        method: "GET",
        path: "/ops/nip05-verifications",
    },
    AdminRoute {
        method: "POST",
        path: "/ops/nip05-verifications/:pubkey/reverify",
    },
    AdminRoute {
        method: "GET",
        path: "/ops/storage/counts",
    },
];

/// The fallback for a path this surface does not serve: the capture's plain 404.
async fn not_found(
    axum::extract::State(_state): axum::extract::State<Arc<AdminState>>,
) -> axum::response::Response {
    controllers::request_context::not_found()
}

/// Converts the table's Express-style parameter (`:pubkey`) to axum's (`{pubkey}`).
pub fn axum_path(path: &str) -> String {
    let mut converted = String::with_capacity(path.len());
    let mut rest = path;
    while let Some(index) = rest.find(':') {
        converted.push_str(&rest[..index]);
        let tail = &rest[index + 1..];
        let end = tail.find('/').filter(|end| *end > 0).unwrap_or(tail.len());
        converted.push('{');
        converted.push_str(&tail[..end]);
        converted.push('}');
        rest = &tail[end..];
    }
    converted.push_str(rest);
    converted
}

/// Builds the whole admin surface under `<prefix>/admin`.
///
/// The prefix is fixed here, when the router is built: a page whose scripts were rewritten for
/// a prefix the routes are not mounted at would `404` (D10). `nostream-admin` does not bind a
/// socket (D13); the daemon serves this router from the one listener it owns.
pub fn mount(state: Arc<AdminState>) -> Router {
    let prefix = state.path_prefix();
    let base = format!("{prefix}/admin");

    Router::new()
        // The console requests `<prefix>/admin/`; the bare `<prefix>/admin` is the same page
        // for a hand-typed URL, as the capture's `router.get('/')` under its mount is.
        .route(&format!("{base}/"), get(controllers::get_dashboard::handle))
        .route(&base, get(controllers::get_dashboard::handle))
        .route(
            &format!("{base}/dashboard"),
            get(controllers::get_dashboard::handle),
        )
        .route(
            &format!("{base}/assets/{{*path}}"),
            get(controllers::get_asset::handle),
        )
        .route(
            &format!("{base}/login"),
            post(controllers::post_login::handle),
        )
        .route(
            &format!("{base}/logout"),
            post(controllers::post_logout::handle),
        )
        .route(
            &format!("{base}/session"),
            get(controllers::get_session::handle),
        )
        .route(
            &format!("{base}/health"),
            get(controllers::get_admin_health::handle),
        )
        .route(
            &format!("{base}/metrics"),
            get(controllers::get_metrics::handle),
        )
        .route(
            &format!("{base}/network-health"),
            get(controllers::get_network_health::handle),
        )
        .route(
            &format!("{base}/network-health/history"),
            get(controllers::get_network_health_history::handle),
        )
        .route(
            &format!("{base}/network-health/run"),
            post(controllers::post_network_health_run::handle),
        )
        .route(
            &format!("{base}/audit-log"),
            get(controllers::get_audit_log::handle),
        )
        .route(
            &format!("{base}/diagnostics/export"),
            get(controllers::get_diagnostics_export::handle),
        )
        .route(
            &format!("{base}/moderation/limits"),
            get(controllers::get_moderation_limits::handle),
        )
        .route(
            &format!("{base}/moderation/limits"),
            patch(controllers::patch_moderation_limits::handle),
        )
        .route(
            &format!("{base}/moderation/actions"),
            post(controllers::post_moderation_actions::handle),
        )
        .route(
            &format!("{base}/moderation/stats"),
            get(controllers::get_moderation_stats::handle),
        )
        .route(
            &format!("{base}/settings"),
            get(controllers::get_settings::handle),
        )
        .route(
            &format!("{base}/settings/backups"),
            get(controllers::get_settings_backups::handle),
        )
        .route(
            &format!("{base}/settings/schema"),
            get(controllers::get_settings_schema::handle),
        )
        .route(
            &format!("{base}/settings"),
            patch(controllers::patch_settings::handle),
        )
        .route(
            &format!("{base}/settings/validate"),
            post(controllers::post_settings_validate::handle),
        )
        .route(
            &format!("{base}/settings/restore"),
            post(controllers::post_settings_restore::handle),
        )
        .route(
            &format!("{base}/notifications"),
            get(controllers::get_notifications::handle),
        )
        .route(
            &format!("{base}/notifications"),
            patch(controllers::patch_notifications::handle),
        )
        .route(
            &format!("{base}/notifications/deliveries"),
            get(controllers::get_notification_delivery_log::handle),
        )
        .route(
            &format!("{base}/notifications/test"),
            post(controllers::post_notification_test::handle),
        )
        .route(
            &format!("{base}/ops/workers"),
            get(controllers::get_ops_workers::handle),
        )
        .route(
            &format!("{base}/ops/nip05-verifications"),
            get(controllers::get_ops_nip05_verifications::handle),
        )
        .route(
            &format!("{base}/ops/nip05-verifications/{{pubkey}}/reverify"),
            post(controllers::post_ops_nip05_reverify::handle),
        )
        .route(
            &format!("{base}/ops/storage/counts"),
            get(controllers::get_ops_storage_counts::handle),
        )
        // One mount, so the paths this router does not serve answer the capture's
        // `404 text/plain "Not Found"` rather than axum's empty 404 (Behaviour today 9).
        .fallback(not_found)
        // `from_fn` wraps the router once per call, so the last layer added is the outermost:
        // `content_security` runs first and stamps every response, and `admin_enabled` runs
        // inside it and answers `404` before any handler does.
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            controllers::admin_enabled_middleware::admin_enabled,
        ))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            controllers::admin_enabled_middleware::content_security,
        ))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    /// The 30 routes of `src/routes/admin/index.ts:49-221`, in registration order.
    const CAPTURE: [(&str, &str); 30] = [
        ("GET", "/"),
        ("GET", "/dashboard"),
        ("POST", "/login"),
        ("POST", "/logout"),
        ("GET", "/session"),
        ("GET", "/health"),
        ("GET", "/metrics"),
        ("GET", "/network-health"),
        ("GET", "/network-health/history"),
        ("POST", "/network-health/run"),
        ("GET", "/audit-log"),
        ("GET", "/diagnostics/export"),
        ("GET", "/moderation/limits"),
        ("PATCH", "/moderation/limits"),
        ("POST", "/moderation/actions"),
        ("GET", "/moderation/stats"),
        ("GET", "/settings"),
        ("GET", "/settings/backups"),
        ("GET", "/settings/schema"),
        ("PATCH", "/settings"),
        ("POST", "/settings/validate"),
        ("POST", "/settings/restore"),
        ("GET", "/notifications"),
        ("PATCH", "/notifications"),
        ("GET", "/notifications/deliveries"),
        ("POST", "/notifications/test"),
        ("GET", "/ops/workers"),
        ("GET", "/ops/nip05-verifications"),
        ("POST", "/ops/nip05-verifications/:pubkey/reverify"),
        ("GET", "/ops/storage/counts"),
    ];

    #[test]
    fn the_route_table_is_the_captures_thirty_routes() {
        let table: Vec<(&str, &str)> = ADMIN_ROUTES
            .iter()
            .map(|route| (route.method, route.path))
            .collect();
        assert_eq!(table, CAPTURE.to_vec());
        assert_eq!(
            PREFIX_MIDDLEWARE,
            [
                "rateLimiterMiddleware",
                "adminEnabledMiddleware",
                "/assets (static)"
            ]
        );
    }

    #[test]
    fn a_parameter_path_becomes_axum_s() {
        assert_eq!(
            axum_path("/ops/nip05-verifications/:pubkey/reverify"),
            "/ops/nip05-verifications/{pubkey}/reverify"
        );
        assert_eq!(axum_path("/settings"), "/settings");
    }
}
