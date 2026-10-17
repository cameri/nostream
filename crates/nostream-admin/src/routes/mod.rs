//! The admin route table. Mirrors `src/routes/admin/index.ts` at the capture: all eighteen
//! registered admin routes, in registration order, plus the two `router.use` middlewares and
//! the `/assets` static mount that precede them.
//!
//! No `axum` in Phase 1: the routes are a typed table, not mounted handlers.

use crate::error::AdminError;

/// One route of the admin API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminRoute {
    pub method: &'static str,
    pub path: &'static str,
}

/// The table, in the order the capture registers them (`src/routes/admin/index.ts`).
pub const ADMIN_ROUTES: [AdminRoute; 18] = [
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
];

/// The two `router.use` middlewares and the static mount that precede the table
/// (`rateLimiterMiddleware`, `adminEnabledMiddleware`, `/assets` static files).
pub const PREFIX_MIDDLEWARE: [&str; 3] = [
    "rateLimiterMiddleware",
    "adminEnabledMiddleware",
    "/assets (static)",
];

/// Mounts the table onto a Phase-2 HTTP router.
///
/// Phase 1 stub — job 005; will mount the routes; see `src/routes/admin/index.ts`.
pub fn mount() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::routes::mount",
    })
}
