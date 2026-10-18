//! The admin controllers and request handlers. Mirrors `src/controllers/admin/` (16 files)
//! and `src/handlers/request-handlers/` (14 files) at the capture commit.

pub mod admin_auth_middleware;
pub mod admin_enabled_middleware;
pub mod admin_json_body_middleware;
pub mod admin_rate_limit_middleware;
pub mod get_dashboard;
pub mod get_health;
pub mod get_metrics;
pub mod get_network_health;
pub mod get_notification_delivery_log;
pub mod get_notifications;
pub mod get_privacy;
pub mod get_readyz;
pub mod get_session;
pub mod get_settings;
pub mod get_settings_backups;
pub mod get_settings_schema;
pub mod get_terms;
pub mod nodeinfo;
pub mod patch_notifications;
pub mod patch_settings;
pub mod post_login;
pub mod post_logout;
pub mod post_notification_test;
pub mod post_settings_restore;
pub mod post_settings_validate;
pub mod rate_limiter_middleware;
pub mod root;
pub mod with_admin_controller_request_handler;
pub mod with_controller_request_handler;
