//! `--mcp-stdio`: the admin MCP server on stdin/stdout, in a process of its own.
//!
//! It composes an [`AdminState`](nostream_admin::AdminState) of its own over the same config
//! directory rather than sharing the console's: `--mcp-stdio` returns before the daemon's
//! `serve` loop would start, so the two modes are alternatives, and running both against one
//! directory is outside ADR 0012 D9 — the audit file and the settings write each assume one
//! writer per configuration (D18).
//!
//! The mode binds **no socket** — `nostreamd` stays the crate that binds, and this mode is not
//! one of its listeners (D13) — and opens **no store of its own**: the admin state comes from
//! [`crate::admin_http::compose`] over an `unavailable::stores()` bundle composed here, as the
//! relay path composes its own in `crates/nostreamd/src/main.rs`'s `serve`. The two are
//! independent `Arc`s in two processes, not one shared value (D7, D18), and while the store is
//! unwired neither opens an LMDB directory at all — so ADR 0012 D9's second-writer hazard cannot
//! arise. When the store is wired, `main.rs`'s bundle and this one have to be wired together in
//! the same change, or this mode keeps answering the store-backed tools with the store's own
//! `NotImplemented` message (R19).
//!
//! The credential is this mode's own and comes from its two flags, never the environment: the
//! variable that used to carry a console session token is retired, and a mode started with it
//! refuses to run rather than quietly ignoring it (R26, D19). The server takes the credential as
//! a value and re-reads a file-delivered document on every call, so a rewrite or a deletion is
//! the revocation.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use nostream_config::SettingsPaths;
use nostream_core::nip05::Nip05Fetch;
use nostream_mcp::Credential;
use nostream_services::HttpClient;
use rmcp::ServiceExt;
use rmcp::model::Implementation;

use crate::DaemonError;

/// The variable that carried a console session token to this mode, until it was retired (R26).
pub const RETIRED_TOKEN_ENV: &str = "NOSTREAM_ADMIN_TOKEN";

/// The credential the mode's flags name (R27): exactly one of the two, and never the environment.
///
/// Every refusal here happens before the pipe is served, so a half-migrated deployment fails to
/// start with the fix named instead of answering `Unauthorized` to every call.
pub fn resolve_credential(file: Option<&Path>, fd: Option<i32>) -> Result<Credential, DaemonError> {
    if std::env::var_os(RETIRED_TOKEN_ENV).is_some() {
        return Err(DaemonError::Setup(format!(
            "{RETIRED_TOKEN_ENV} is retired: a console session token does not authenticate \
             --mcp-stdio. Start the mode with --admin-token-file <path> (mode 0600) or \
             --admin-token-fd <n>."
        )));
    }
    match (file, fd) {
        (Some(path), None) => Credential::from_file(path).map_err(start_up),
        (None, Some(fd)) => Credential::from_descriptor(fd).map_err(start_up),
        (None, None) => Err(DaemonError::Setup(
            "--mcp-stdio needs a credential: pass --admin-token-file <path> or \
             --admin-token-fd <n>"
                .to_owned(),
        )),
        (Some(_), Some(_)) => Err(DaemonError::Setup(
            "--mcp-stdio takes one credential, not two: pass --admin-token-file <path> or \
             --admin-token-fd <n>"
                .to_owned(),
        )),
    }
}

fn start_up(error: nostream_mcp::McpError) -> DaemonError {
    DaemonError::Setup(error.to_string())
}

/// Serves the MCP server on stdin/stdout until the peer closes stdin, then returns.
pub async fn serve(
    cwd: PathBuf,
    config_dir: PathBuf,
    credential: Credential,
) -> Result<(), DaemonError> {
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
        credential,
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
