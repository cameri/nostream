//! The HTTP half of the one listener: `nostream-admin`'s router served over the sockets the
//! relay's accept loop hands over, plus the environment resolution the admin state needs.
//!
//! `nostream-admin` builds a `Router` and never binds (D13); this module is where the daemon
//! turns one accepted `TcpStream` into HTTP/1.1 for it (D1), through `hyper` and
//! `hyper-util`'s service adapter.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use nostream_admin::{AdminState, GrafanaSettings};
use nostream_core::lifecycle::ShutdownState;

use crate::DaemonError;

/// The HTTP fallback the relay's accept loop calls.
#[derive(Debug, Clone)]
pub struct AdminHttp {
    router: Router,
}

impl AdminHttp {
    /// Wraps a built router.
    pub fn new(router: Router) -> Arc<Self> {
        Arc::new(Self { router })
    }
}

impl nostream_relay::dispatch::HttpFallback for AdminHttp {
    fn serve(
        &self,
        stream: tokio::net::TcpStream,
        peer: SocketAddr,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        let router = nostream_admin::with_peer_address(self.router.clone(), peer);
        Box::pin(async move {
            let io = TokioIo::new(stream);
            let service = TowerToHyperService::new(router);
            if let Err(error) = hyper::server::conn::http1::Builder::new()
                .serve_connection(io, service)
                .await
            {
                tracing::debug!(%peer, error = %error, "an HTTP connection ended with an error");
            }
        })
    }
}

/// Builds the admin state and its router.
pub fn compose(
    paths: nostream_config::SettingsPaths,
    resources_root: std::path::PathBuf,
    stores: Arc<nostream_services::ServiceStores>,
    http: Arc<dyn nostream_services::HttpClient>,
    fetch: Arc<dyn nostream_core::nip05::Nip05Fetch>,
) -> Result<(Arc<AdminState>, Router), DaemonError> {
    let state = Arc::new(AdminState::new(nostream_admin::AdminStateConfig {
        paths,
        resources_root,
        secret: secret_from_env(),
        stores,
        http,
        fetch,
        clock: Arc::new(nostream_core::clock::SystemClock),
        grafana: grafana_from_env(),
        metrics_interval: metrics_interval_from_env(),
        worker_type: worker_type(),
        worker_index: worker_index(),
        worker_count_override: worker_count_override(),
        password_override: password_override(),
    }));

    let router = nostream_admin::mount(Arc::clone(&state));
    Ok((state, router))
}

/// One warning when the surface is on and the session key is absent (R3): every login and
/// session check would answer `500` from then on.
pub fn warn_when_the_surface_has_no_secret(state: &AdminState) {
    let enabled = state
        .settings()
        .ok()
        .and_then(|settings| settings.admin.map(|admin| admin.enabled))
        .unwrap_or(false);
    if enabled && state.secret().is_none() {
        tracing::warn!(
            "admin.enabled is true and SECRET is not set; every admin login and session check will answer 500"
        );
    }
}

/// Publishes the `maintenance` heartbeat at start and every
/// [`nostream_admin::state::HEARTBEAT_INTERVAL`] until the drain (R11).
pub async fn publish_heartbeats(state: Arc<AdminState>, shutdown: ShutdownState) {
    state.publish_heartbeat("maintenance", None);
    let mut interval = tokio::time::interval(nostream_admin::state::HEARTBEAT_INTERVAL);
    interval.tick().await;
    loop {
        tokio::select! {
            _ = interval.tick() => state.publish_heartbeat("maintenance", None),
            _ = shutdown.wait_for_drain() => break,
        }
    }
}

/// Rewrites the relay status document at start and every
/// [`nostream_admin::utils::status::STATUS_INTERVAL`] until the drain (R6).
///
/// The document is the relay process's own facts — uptime, the live connection total, the worker
/// rows and the key the relay signs with — published for the MCP door, which runs in another
/// process. A failed assembly
/// or write is one warning carrying the path and the error; the loop continues, and a full
/// disk does not end the daemon.
pub async fn publish_status(
    state: Arc<AdminState>,
    connections: Arc<nostream_relay::connection_cap::ConnectionCap>,
    relay_pubkey: Option<nostream_core::Pubkey>,
    shutdown: ShutdownState,
) {
    let path = nostream_admin::utils::status::path(state.paths());
    let mut interval = tokio::time::interval(nostream_admin::utils::status::STATUS_INTERVAL);
    // `interval`'s first tick is immediate; consume it, as `publish_heartbeats` does, so the
    // loop's own write is the start's single write and the next is one cadence later.
    interval.tick().await;

    loop {
        let active = u64::try_from(connections.live_total()).unwrap_or(u64::MAX);

        match nostream_admin::utils::status::collect(&state, active, relay_pubkey) {
            Ok(document) => {
                if let Err(error) = nostream_admin::utils::status::write(&path, &document) {
                    tracing::warn!(
                        path = %path.display(),
                        %error,
                        "the relay status document was not written"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(
                    path = %path.display(),
                    %error,
                    "the relay status document was not assembled"
                );
            }
        }

        tokio::select! {
            _ = interval.tick() => {}
            _ = shutdown.wait_for_drain() => break,
        }
    }
}

/// `SECRET` as a value: the crate reads no environment for it (R3, Assumption 9).
pub fn secret_from_env() -> Option<Vec<u8>> {
    match std::env::var("SECRET") {
        Ok(secret) if !secret.is_empty() && secret != "changeme" => Some(secret.into_bytes()),
        _ => None,
    }
}

/// `ADMIN_PASSWORD` when it is non-empty (Value 10).
pub fn password_override() -> Option<String> {
    std::env::var("ADMIN_PASSWORD")
        .ok()
        .filter(|password| !password.is_empty())
}

/// `GRAFANA_URL` and `GRAFANA_DASHBOARD_UID` with the capture's defaults (Value 44).
pub fn grafana_from_env() -> GrafanaSettings {
    nostream_admin::utils::grafana::settings(
        std::env::var("GRAFANA_URL").ok().as_deref(),
        std::env::var("GRAFANA_DASHBOARD_UID").ok().as_deref(),
    )
}

/// `ADMIN_METRICS_SSE_INTERVAL_MS` with the capture's floor (Value 27).
pub fn metrics_interval_from_env() -> Duration {
    nostream_admin::utils::metrics::resolve_interval(
        std::env::var("ADMIN_METRICS_SSE_INTERVAL_MS")
            .ok()
            .as_deref(),
    )
}

/// `WORKER_TYPE`, defaulting to the capture's `primary`.
pub fn worker_type() -> String {
    std::env::var("WORKER_TYPE").unwrap_or_else(|_| "primary".to_owned())
}

/// `WORKER_INDEX`, when set.
pub fn worker_index() -> Option<String> {
    std::env::var("WORKER_INDEX")
        .ok()
        .filter(|index| !index.is_empty())
}

/// `WORKER_COUNT`, when the operator set it (Value 40).
pub fn worker_count_override() -> Option<u32> {
    std::env::var("WORKER_COUNT")
        .ok()
        .and_then(|count| count.parse().ok())
}
