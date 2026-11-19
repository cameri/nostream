//! The session gate. Mirrors the cookie half of
//! `src/handlers/request-handlers/admin-auth-middleware.ts` with NIP-98 left out (D6).

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::Response;

use crate::controllers::with_admin_controller_request_handler::error_message;
use crate::state::AdminState;
use crate::utils::session;

/// A verified session: the `expiresAt` the token carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Session {
    pub expires_at: i64,
}

/// The token's `expiresAt` when the request carries a valid session, without failing.
pub fn session_expires_at(
    state: &AdminState,
    authorization: Option<&str>,
    cookie: Option<&str>,
) -> Option<i64> {
    let key = session::session_key(state.secret()?);
    let token = session::token_from_headers(authorization, cookie)?;
    if session::is_valid_token(&key, &token, state.clock().now_secs()) {
        session::parse_token(&token)
    } else {
        None
    }
}

impl FromRequestParts<Arc<AdminState>> for Session {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AdminState>,
    ) -> Result<Self, Self::Rejection> {
        let header = |name: &str| {
            parts
                .headers
                .get(name)
                .and_then(|value| value.to_str().ok())
        };
        let authorization = header("authorization");
        let cookie = header("cookie");

        if state.secret().is_none() {
            tracing::warn!("SECRET is not set; the admin session cannot be verified");
            return Err(error_message(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            ));
        }

        match session_expires_at(state, authorization, cookie) {
            Some(expires_at) => Ok(Self { expires_at }),
            None => Err(error_message(StatusCode::UNAUTHORIZED, "Unauthorized")),
        }
    }
}
