//! The admin controllers and request handlers. Mirrors `src/controllers/admin/` and
//! `src/handlers/request-handlers/` at the capture commit.

pub mod admin_auth_middleware;
pub mod admin_json_body_middleware;
pub mod admin_rate_limit_middleware;
pub mod get_dashboard;
pub mod get_health;
pub mod get_privacy;
pub mod get_readyz;
pub mod get_settings;
pub mod get_terms;
pub mod nodeinfo;
pub mod patch_settings;
pub mod post_login;
pub mod post_settings_validate;
pub mod root;
