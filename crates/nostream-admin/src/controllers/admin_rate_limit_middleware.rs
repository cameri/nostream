//! The two admin rate limiters as request guards. Mirrors
//! `src/handlers/request-handlers/admin-rate-limit-middleware.ts`.
//!
//! The capture mounts `adminRateLimitMiddleware` on every API route but `/login`, which mounts
//! the login limiter instead; both answer `429 {"error":"Too many requests"}` and both bypass a
//! remote address in `limits.admin.ipWhitelist` (Value 4–6, Value 48).

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::Response;

use crate::controllers::request_context::{ClientInfo, RequestSettings};
use crate::controllers::with_admin_controller_request_handler::error_message;
use crate::state::AdminState;
use crate::utils::rate_limit::{LimitScope, is_rate_limited};

fn too_many_requests() -> Response {
    error_message(StatusCode::TOO_MANY_REQUESTS, "Too many requests")
}

async fn guard(
    parts: &mut Parts,
    state: &Arc<AdminState>,
    scope: LimitScope,
) -> Result<(), Response> {
    let RequestSettings(settings) = RequestSettings::from_request_parts(parts, state).await?;
    let ClientInfo { address, .. } = ClientInfo::from_request_parts(parts, state).await?;
    if is_rate_limited(state, &settings, &address, scope) {
        return Err(too_many_requests());
    }
    Ok(())
}

/// `adminRateLimitMiddleware`: one hit against `limits.admin.rateLimits`.
pub struct AdminRateLimited;

impl FromRequestParts<Arc<AdminState>> for AdminRateLimited {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AdminState>,
    ) -> Result<Self, Self::Rejection> {
        guard(parts, state, LimitScope::Admin).await?;
        Ok(Self)
    }
}

/// `adminLoginRateLimitMiddleware`: one hit against `limits.admin.loginRateLimits`, a separate
/// key scope from [`AdminRateLimited`].
pub struct LoginRateLimited;

impl FromRequestParts<Arc<AdminState>> for LoginRateLimited {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AdminState>,
    ) -> Result<Self, Self::Rejection> {
        guard(parts, state, LimitScope::Login).await?;
        Ok(Self)
    }
}
