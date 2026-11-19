//! `POST <prefix>/admin/ops/nip05-verifications/:pubkey/reverify`. Mirrors
//! `src/controllers/admin/post-ops-nip05-reverify-controller.ts` (Value 21).

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::request_context::{ClientInfo, RequestSettings};
use crate::controllers::with_admin_controller_request_handler::{
    HandlerResult, error_message, json_response,
};
use crate::state::AdminState;

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    client: ClientInfo,
    RequestSettings(settings): RequestSettings,
    Path(pubkey): Path<String>,
) -> HandlerResult {
    let Some(pubkey) = crate::utils::nip05::parse_pubkey(&pubkey) else {
        return Ok(error_message(StatusCode::BAD_REQUEST, "Invalid pubkey"));
    };

    let disabled = match settings.nip05.as_ref() {
        None => true,
        Some(nip05) => nip05.mode == nostream_config::settings::Nip05Mode::Disabled,
    };
    if disabled {
        return Ok(error_message(
            StatusCode::CONFLICT,
            "NIP-05 verification is disabled",
        ));
    }

    let existing = state.stores().nip05.find_by_pubkey(&pubkey).await?;
    let Some(existing) = existing else {
        return Ok(error_message(
            StatusCode::NOT_FOUND,
            "Verification record not found",
        ));
    };

    match crate::utils::nip05::reverify(&state, &existing).await {
        Ok(updated) => {
            crate::controllers::post_login::record_audit(&state, "nip05.reverify", &client.address);
            let row = crate::utils::nip05::to_row(
                &updated,
                crate::utils::nip05::verify_expiration_ms(&settings),
                state.clock().now_ms(),
            );
            Ok(json_response(
                StatusCode::OK,
                &json!({ "verification": row }),
            ))
        }
        Err(error) => {
            tracing::warn!(error = %error, "NIP-05 re-verification failed");
            Ok(error_message(
                StatusCode::BAD_GATEWAY,
                "Re-verification failed",
            ))
        }
    }
}
