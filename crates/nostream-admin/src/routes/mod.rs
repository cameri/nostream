//! The admin route table. Mirrors `src/routes/admin/index.ts`.
//!
//! No `axum` in Phase 1: the routes are a typed table, not mounted handlers.

use crate::error::AdminError;

/// One route of the admin API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminRoute {
    pub method: &'static str,
    pub path: &'static str,
}

/// The table, in the order the capture registers them.
pub const ADMIN_ROUTES: [AdminRoute; 3] = [
    AdminRoute {
        method: "POST",
        path: "/admin/login",
    },
    AdminRoute {
        method: "GET",
        path: "/admin/settings",
    },
    AdminRoute {
        method: "PATCH",
        path: "/admin/settings",
    },
];

/// Mounts the table onto a Phase-2 HTTP router.
///
/// Phase 1 stub — job 005; will mount the routes; see `src/routes/admin/index.ts`.
pub fn mount() -> Result<(), AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::routes::mount",
    })
}
