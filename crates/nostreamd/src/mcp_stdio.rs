//! `--mcp-stdio`: the admin MCP server on stdin/stdout, in the daemon's own process.
//!
//! The mode binds **no socket** — `nostreamd` stays the crate that binds, and this mode is not
//! one of its listeners (D13) — and opens **no store of its own**: the admin state comes from
//! [`crate::admin_http::compose`] over the same `unavailable::stores()` bundle the relay path
//! hands over, so no second process ever opens the LMDB directory (ADR 0012 D9). While the store
//! is unwired, the store-backed tools answer the store's own `NotImplemented` message (R19).
//!
//! The credential is read once here and passed to the server as a value: the server never reads
//! the environment (R7).

use std::path::PathBuf;
use std::sync::Arc;

use nostream_config::SettingsPaths;
use nostream_core::nip05::Nip05Fetch;
use nostream_services::HttpClient;
use rmcp::ServiceExt;
use rmcp::model::Implementation;

use crate::DaemonError;

/// The session token a stdio caller presents, minted by `POST /admin/login` and verified with
/// the console's own function (R7).
pub const ADMIN_TOKEN_ENV: &str = "NOSTREAM_ADMIN_TOKEN";

/// The token the environment carries, when it carries a non-empty one.
pub fn token_from_env() -> Option<String> {
    std::env::var(ADMIN_TOKEN_ENV)
        .ok()
        .filter(|token| !token.is_empty())
}

/// Serves the MCP server on stdin/stdout until the peer closes stdin, then returns.
pub async fn serve(cwd: PathBuf, config_dir: PathBuf) -> Result<(), DaemonError> {
    let stores = Arc::new(nostream_services::unavailable::stores());
    let client = Arc::new(
        nostream_services::ReqwestClient::new()
            .map_err(|error| DaemonError::Setup(error.to_string()))?,
    );
    let http: Arc<dyn HttpClient> = client.clone();
    let fetch: Arc<dyn Nip05Fetch> = client;
    let paths = SettingsPaths::from_config_dir(&cwd, config_dir);
    let (state, _router) =
        crate::admin_http::compose(paths, cwd.join("resources"), stores, http, fetch)?;

    let server = nostream_mcp::AdminMcp::new(
        state,
        token_from_env(),
        Implementation::new(nostream_mcp::MCP_SERVER_NAME, env!("CARGO_PKG_VERSION")),
    );

    // The one forced line: it is what tells a reader — and AC5's first case — that the banner
    // went to stderr rather than into the JSON-RPC stream (R18).
    tracing::info!("mcp server on stdio");

    let service = match server.serve(rmcp::transport::stdio()).await {
        Ok(service) => service,
        // A peer that closes stdin before the handshake has gone away without asking for
        // anything: there is nothing left to serve, and that is not a failure (R17).
        Err(rmcp::service::ServerInitializeError::ConnectionClosed(context)) => {
            tracing::info!(%context, "the peer closed stdin before the MCP handshake");
            return Ok(());
        }
        Err(error) => return Err(DaemonError::Setup(format!("mcp stdio: {error}"))),
    };
    service
        .waiting()
        .await
        .map_err(|error| DaemonError::Setup(format!("mcp stdio: {error}")))?;
    Ok(())
}
