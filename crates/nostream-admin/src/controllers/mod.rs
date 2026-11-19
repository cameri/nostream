//! The admin controllers and request handlers. Mirrors `src/controllers/admin/` and
//! `src/handlers/request-handlers/` at the capture commit.
//!
//! The middleware modules are the request-side wrappers the capture mounts beside its
//! controllers: the enabled gate and the CSP header (`admin-enabled-middleware.ts` + the
//! header in `web-app-factory.ts`), the session gate (`admin-auth-middleware.ts`, cookie only
//! per D6), the JSON body middleware (`admin-json-body-middleware.ts`) and the two rate
//! limiters (`admin-rate-limit-middleware.ts`). `request_context` is the per-request settings
//! and address read the capture does inside each handler.
//!
//! **The six document handlers stay stubs.** `get_health`, `get_privacy`, `get_readyz`,
//! `get_terms`, `nodeinfo` and `root` are the capture's non-admin document controllers
//! (`src/handlers/request-handlers/*-request-handler.ts`); no console file calls them and no
//! Rust route mounts them, so each keeps its Phase-1 stub label (R15). The admin health
//! route (`src/controllers/admin/get-health-controller.ts`) is `get_admin_health` here.
//!
//! **The app-level connection limiter is not applied to HTTP** (D1): `rate-limiter-middleware.ts`
//! drops the socket on limit, which a browser cannot tell from a network error, and the
//! console's own admin limiter already bounds its traffic.

pub mod admin_auth_middleware;
pub mod admin_enabled_middleware;
pub mod admin_json_body_middleware;
pub mod admin_rate_limit_middleware;
pub mod get_admin_health;
pub mod get_asset;
pub mod get_audit_log;
pub mod get_dashboard;
pub mod get_diagnostics_export;
pub mod get_health;
pub mod get_metrics;
pub mod get_moderation_limits;
pub mod get_moderation_stats;
pub mod get_network_health;
pub mod get_network_health_history;
pub mod get_notification_delivery_log;
pub mod get_notifications;
pub mod get_ops_nip05_verifications;
pub mod get_ops_storage_counts;
pub mod get_ops_workers;
pub mod get_privacy;
pub mod get_readyz;
pub mod get_session;
pub mod get_settings;
pub mod get_settings_backups;
pub mod get_settings_schema;
pub mod get_terms;
pub mod nodeinfo;
pub mod patch_moderation_limits;
pub mod patch_notifications;
pub mod patch_settings;
pub mod post_login;
pub mod post_logout;
pub mod post_moderation_actions;
pub mod post_network_health_run;
pub mod post_notification_test;
pub mod post_ops_nip05_reverify;
pub mod post_settings_restore;
pub mod post_settings_validate;
pub mod request_context;
pub mod root;
pub mod with_admin_controller_request_handler;
