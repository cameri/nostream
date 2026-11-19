//! `PATCH <prefix>/admin/moderation/limits`: merge a limits patch and persist it. Mirrors
//! `src/controllers/admin/patch-moderation-limits-controller.ts`.
//!
//! The console does not call this route; it is registered because the capture registers it
//! (`src/routes/admin/index.ts:112-119`).

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_json_body_middleware::{
    JsonBody, invalid_request, moderation_limits_patch,
};
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::post_moderation_actions::{moderation_error_response, persist};
use crate::controllers::request_context::{ClientInfo, RequestDocument};
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, json_response};
use crate::state::AdminState;
use crate::utils::moderation::read_limits;

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    client: ClientInfo,
    RequestDocument { merged, defaults }: RequestDocument,
    JsonBody(body): JsonBody,
) -> HandlerResult {
    let Some(patch) = moderation_limits_patch(&body) else {
        return Ok(invalid_request());
    };

    let current = read_limits(&merged);
    // `mergeAdminModerationLimitsPatch`: a list the patch carries replaces the stored one, and
    // one it omits is left alone.
    let next = crate::utils::moderation::ModerationLimits {
        pubkey: crate::utils::moderation::Pair {
            blacklist: patch
                .pubkey_blacklist
                .unwrap_or_else(|| current.pubkey.blacklist.clone()),
            whitelist: patch
                .pubkey_whitelist
                .unwrap_or_else(|| current.pubkey.whitelist.clone()),
        },
        kind: crate::utils::moderation::Pair {
            blacklist: patch
                .kind_blacklist
                .unwrap_or_else(|| current.kind.blacklist.clone()),
            whitelist: patch
                .kind_whitelist
                .unwrap_or_else(|| current.kind.whitelist.clone()),
        },
        rate_limit_bypass: crate::utils::moderation::BypassLists {
            pubkeys: patch
                .bypass_pubkeys
                .unwrap_or_else(|| current.rate_limit_bypass.pubkeys.clone()),
            ip_addresses: patch
                .bypass_ip_addresses
                .unwrap_or_else(|| current.rate_limit_bypass.ip_addresses.clone()),
        },
    };

    if let Err(error) = persist(
        &state,
        &defaults,
        &next,
        "moderation.limits.updated",
        json!({}),
        &client.address,
    ) {
        return Ok(moderation_error_response(error));
    }

    Ok(json_response(
        StatusCode::OK,
        &json!({ "ok": true, "limits": next }),
    ))
}
