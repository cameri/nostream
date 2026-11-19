//! `POST <prefix>/admin/login`: the password check, the session token and its cookie.
//! Mirrors `PasswordAdminAuthProvider.handleLogin`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;

use serde_json::json;

use crate::auth::AuthSettings;
use crate::controllers::admin_json_body_middleware::{LoginBody, invalid_request, login_password};
use crate::controllers::admin_rate_limit_middleware::LoginRateLimited;
use crate::controllers::request_context::{ClientInfo, RequestSettings};
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, error_message};
use crate::state::AdminState;
use crate::utils::http::path_prefix_from_relay_url;
use crate::utils::session::cookie_header;

/// The environment override the composition root resolved into the state.
fn auth_settings(state: &AdminState, settings: &nostream_config::Settings) -> AuthSettings {
    AuthSettings::from_settings(settings, state.password_override())
}

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: LoginRateLimited,
    client: ClientInfo,
    RequestSettings(settings): RequestSettings,
    LoginBody(body): LoginBody,
) -> HandlerResult {
    let Some(password) = login_password(&body) else {
        return Ok(invalid_request());
    };

    let auth = auth_settings(&state, &settings);
    // The override wins over the hash, and it is a byte compare; the hash is scrypt work, so
    // it runs on the blocking pool under the state's permit cap.
    let verified = match (auth.password_override(), auth.password_hash()) {
        (Some(_), _) => auth.verify_password(&password),
        (None, Some(hash)) => state.verify_admin_password(password, hash.to_owned()).await,
        (None, None) => false,
    };
    if !verified {
        return Ok(error_message(StatusCode::UNAUTHORIZED, "Unauthorized"));
    }

    let now_seconds = state.clock().now_secs();
    let (token, expires_at) = match auth.mint(state.secret(), now_seconds) {
        Ok(minted) => minted,
        Err(error) => {
            tracing::error!(error = %error, "the admin session could not be signed");
            return Ok(error_message(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            ));
        }
    };

    record_audit(&state, "admin.login", &client.address, None);

    let prefix = path_prefix_from_relay_url(&settings.info.relay_url);
    let cookie = cookie_header(&prefix, &token, auth.session_ttl(), client.secure);

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json".to_owned()),
            (header::SET_COOKIE, cookie),
        ],
        json!({ "authenticated": true, "expiresAt": expires_at }).to_string(),
    )
        .into_response())
}

/// Appends the audit entry, logging rather than failing: the action already happened.
///
/// One call is one entry: a caller that has a detail passes it here rather than appending a
/// second entry for the same action with the capture's `detail` field.
pub fn record_audit(
    state: &AdminState,
    action: &str,
    remote_address: &str,
    detail: Option<serde_json::Value>,
) {
    let address = if remote_address.is_empty() {
        None
    } else {
        Some(remote_address)
    };
    if let Err(error) = state.append_audit(action, address, detail) {
        tracing::warn!(error = %error, action, "the admin audit entry was not recorded");
    }
}
