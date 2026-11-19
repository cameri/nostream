//! `POST <prefix>/admin/network-health/run`: the manual probe run. Mirrors
//! `src/controllers/admin/post-admin-network-health-run-controller.ts` with D3's wiring: the
//! probe itself is #865's, so an enabled configuration answers `502`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde_json::json;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::request_context::{ClientInfo, RequestSettings};
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, error_message};
use crate::state::AdminState;

/// The `nip66.targets` entries that parse as a relay URL (`filterValidProbeTargets`).
pub fn valid_targets(targets: &[String]) -> Vec<String> {
    let mut valid: Vec<String> = targets
        .iter()
        .map(|target| target.trim().to_owned())
        .filter(|target| is_relay_url(target))
        .collect();
    valid.dedup();
    valid
}

fn is_relay_url(target: &str) -> bool {
    let Some(scheme_end) = target.find("://") else {
        return false;
    };
    let scheme = &target[..scheme_end];
    if !matches!(scheme, "ws" | "wss") {
        return false;
    }
    let rest = &target[scheme_end + 3..];
    rest.split('/').next().is_some_and(|host| !host.is_empty())
}

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
    client: ClientInfo,
    RequestSettings(settings): RequestSettings,
) -> HandlerResult {
    let Some(nip66) = settings.nip66.as_ref() else {
        return Ok(error_message(
            StatusCode::CONFLICT,
            "NIP-66 monitoring is disabled",
        ));
    };
    if !nip66.enabled {
        return Ok(error_message(
            StatusCode::CONFLICT,
            "NIP-66 monitoring is disabled",
        ));
    }

    let valid = valid_targets(&nip66.targets);
    if valid.is_empty() {
        return Ok((
            StatusCode::BAD_REQUEST,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            json!({ "error": "No valid probe targets configured", "invalid": nip66.targets })
                .to_string(),
        )
            .into_response());
    }

    // D3: the probe primitives (`nostream-services::monitor::run_probe`) are #865's labelled
    // stubs, so a configured and valid run has no results to record. Inventing measurements
    // here is the failure mode the porting discipline forbids.
    crate::controllers::post_login::record_audit(&state, "probe.manual_run", &client.address, None);
    Ok(error_message(
        StatusCode::BAD_GATEWAY,
        "Probe run produced no results",
    ))
}
