//! `POST <prefix>/admin/logout`: always `200 {"authenticated":false}` with a clearing cookie,
//! session or not. Mirrors `PasswordAdminAuthProvider.handleLogout`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;

use serde_json::json;

use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::post_login::record_audit;
use crate::controllers::request_context::{ClientInfo, RequestSettings};
use crate::controllers::with_admin_controller_request_handler::HandlerResult;
use crate::state::AdminState;
use crate::utils::http::path_prefix_from_relay_url;
use crate::utils::session::clear_cookie_header;

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    client: ClientInfo,
    RequestSettings(settings): RequestSettings,
) -> HandlerResult {
    record_audit(&state, "admin.logout", &client.address, None);

    let prefix = path_prefix_from_relay_url(&settings.info.relay_url);
    let cookie = clear_cookie_header(&prefix, client.secure);

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json".to_owned()),
            (header::SET_COOKIE, cookie),
        ],
        json!({ "authenticated": false }).to_string(),
    )
        .into_response())
}
