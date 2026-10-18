//! `nostream-admin` owns the admin HTTP surface: the sixteen admin controllers, the route
//! table, the request handlers, the authentication and the admin utils.
//!
//! It owns these TypeScript paths from the capture commit
//! (`242a3001d77149e4d70151ec03060c4ef44a1547`):
//!
//! - `src/handlers/request-handlers/` (all 14 files — the eight HTTP document/health
//!   handlers and the six middlewares/wrappers, including `admin-enabled-middleware`,
//!   `rate-limiter-middleware`, `with-admin-controller-request-handler` and
//!   `with-controller-request-handler`)
//! - `src/controllers/admin/` (all 16) and `src/routes/admin/index.ts` (all 18 routes)
//! - `src/schemas/admin-*.ts` (3)
//! - `src/utils/admin-*.ts` (7 files, except `admin-notifications-settings.ts`, which belongs
//!   to `nostream-config`)
//! - `src/admin/password-admin-auth-provider.ts`
//! - `src/@types/{admin,controllers}.ts`
//! - `src/factories/controllers/*` and `src/factories/admin-auth-provider-factory.ts`
//!
//! The MCP server has **no TypeScript counterpart** at the capture (`grep -rn -i mcp src/` is
//! empty); it is named here as Phase 5 and has no module. No `axum` in Phase 1: handlers are
//! typed skeletons, not mounted.

pub mod auth;
pub mod controllers;
pub mod error;
pub mod routes;
pub mod utils;

pub use error::AdminError;
