//! `nostreamd` — the relay daemon entry point.
//!
//! `anyhow` is allowed here (binaries only, spec D10); the library carries the typed errors.

use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::Parser;
use nostream_config::SettingsPaths;
use nostream_core::clock::SystemClock;
use nostream_core::lifecycle::ShutdownState;
use nostream_core::nip05::Nip05Fetch;
use nostream_core::random::SystemRandom;
use nostream_relay::{Relay, relay::RelayConfig, relay_key::RelayKeySource};
use nostream_services::services::wot_graph_service::WotGraphService;
use nostream_services::{HttpClient, ReqwestClient, ServiceContext};
use nostreamd::{DaemonError, settings_gate, telemetry};

#[derive(Debug, Parser)]
#[command(name = "nostreamd", about = "The nostream relay daemon")]
struct Cli {
    /// The configuration directory (overrides NOSTR_CONFIG_DIR).
    #[arg(long, global = true)]
    config_dir: Option<PathBuf>,

    /// Validate the effective settings and exit.
    #[arg(long)]
    check: bool,

    /// Override the listen port (otherwise PORT, then RELAY_PORT, then 8008, mirroring
    /// `src/app/worker.ts:32`).
    #[arg(long)]
    listen_port: Option<u16>,

    /// Override the log level (info, debug, warn, error).
    #[arg(long)]
    log_level: Option<String>,

    /// Serve the admin MCP server on stdin/stdout and exit when stdin closes. Binds no socket.
    ///
    /// Every call is decided by a scoped token document, delivered either by a regular file
    /// (`--admin-token-file <path>`, which must be mode 0600 and is re-read on every call, so
    /// deleting or rewriting it revokes or narrows the credential) or on an inherited descriptor
    /// (`--admin-token-fd <n>`, read once at start and valid for the life of the process).
    /// Exactly one of the two is required.
    ///
    /// The document is `{"scopes": ["write"]}`; a document with no scopes grants the read tools
    /// (`settings_get`, `list_events`, `get_event`), and the "write" scope adds `settings_set`.
    /// An unknown scope refuses to start, naming it. The mode also needs `admin.enabled: true` in
    /// the settings.
    ///
    /// NOSTREAM_ADMIN_TOKEN is retired: a console session token does not authenticate this mode,
    /// and setting the variable makes the mode refuse to start.
    #[arg(long)]
    mcp_stdio: bool,

    /// The token document the MCP mode reads, on every call. A regular file at mode 0600 or the
    /// mode refuses to start; deleting or rewriting the file is the revocation.
    #[arg(
        long,
        value_name = "PATH",
        requires = "mcp_stdio",
        conflicts_with = "admin_token_fd"
    )]
    admin_token_file: Option<PathBuf>,

    /// The same token document on an inherited descriptor (conventionally 3), read once at
    /// start: the credential then lives as long as the process.
    #[arg(
        long,
        value_name = "N",
        requires = "mcp_stdio",
        conflicts_with = "admin_token_file"
    )]
    admin_token_fd: Option<i32>,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => code,
        Err(DaemonError::InvalidSettings { count }) => {
            eprintln!("settings invalid: {count} issues");
            ExitCode::from(2)
        }
        Err(DaemonError::NotImplemented { module }) => {
            eprintln!("not implemented in Phase 1 (job 005): {module}");
            ExitCode::from(1)
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}

fn run(cli: Cli) -> Result<ExitCode, DaemonError> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let paths = match &cli.config_dir {
        Some(dir) => SettingsPaths::from_config_dir(&cwd, dir),
        None => SettingsPaths::resolve(&cwd),
    };

    let outcome =
        nostream_config::load(&paths).map_err(|error| DaemonError::Setup(error.to_string()))?;
    settings_gate::apply_settings_gate(&outcome, cli.check)?;
    if cli.check {
        return Ok(ExitCode::SUCCESS);
    }

    let settings = outcome.settings;

    // R9's payments refusal belongs to the relay path only, and is checked below, after the
    // `--mcp-stdio` branch returns: the stdio door serves no payments, and D19 retired `SECRET`
    // as a prerequisite for it, so a payment-enabled instance without one can still open it.

    let writer = if cli.mcp_stdio {
        telemetry::LogWriter::Stderr
    } else {
        telemetry::LogWriter::Stdout
    };
    telemetry::init(
        &settings,
        telemetry::resolve_filter(cli.log_level.as_deref()),
        writer,
    )
    .map_err(|error| DaemonError::Setup(error.to_string()))?;

    let config_dir = paths.config_base_dir;

    // R17: the MCP mode serves stdin/stdout and returns; it binds no socket and opens no
    // store of its own, so `--listen-port` is not read on this path.
    let port = cli
        .listen_port
        .or_else(|| {
            std::env::var("PORT")
                .ok()
                .and_then(|value| value.parse().ok())
        })
        .or_else(|| {
            std::env::var("RELAY_PORT")
                .ok()
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(8008u16);
    let listen = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port));

    // R4: `WORKER_COUNT`, then `workers.count`, then the CPU count.
    let worker_threads = nostream_services::scheduler::resolve_worker_count(
        std::env::var("WORKER_COUNT").ok().as_deref(),
        settings
            .workers
            .as_ref()
            .map(|workers| workers.count)
            .unwrap_or(0),
    );

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_threads)
        .enable_all()
        .build()
        .map_err(|error| DaemonError::Setup(format!("tokio runtime: {error}")))?;

    if cli.mcp_stdio {
        // R26, R27: the credential is resolved before the pipe is served, so a retired variable
        // or a document this door cannot accept fails the start rather than every call.
        let credential = nostreamd::mcp_stdio::resolve_credential(
            cli.admin_token_file.as_deref(),
            cli.admin_token_fd,
        )?;
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        return runtime.block_on(async move {
            nostreamd::mcp_stdio::serve(cwd, config_dir, credential).await?;
            Ok(ExitCode::SUCCESS)
        });
    }

    // R9: payments cannot be enabled without a usable `SECRET`. This is the capture's one
    // startup refusal (`src/app/app.ts:86-94`) and it exits 1, not `InvalidSettings`' 2. It is
    // checked here, after the stdio mode has returned, because that door serves no payments.
    if payments_enabled(&settings) && secret_missing() {
        return Err(DaemonError::MissingSecret);
    }

    runtime.block_on(async move { serve(listen, settings, config_dir, port).await })
}

fn payments_enabled(settings: &nostream_config::Settings) -> bool {
    settings
        .payments
        .as_ref()
        .is_some_and(|payments| payments.enabled)
}

fn secret_missing() -> bool {
    !matches!(
        std::env::var("SECRET"),
        Ok(secret) if !secret.is_empty() && secret != "changeme"
    )
}

async fn serve(
    listen: SocketAddr,
    settings: nostream_config::Settings,
    config_dir: PathBuf,
    port: u16,
) -> Result<ExitCode, DaemonError> {
    let acceptor = nostreamd::Acceptor::bind(listen).await?;
    let shutdown = ShutdownState::new();

    let settings = Arc::new(settings);

    // R3: the backend is resolved once, logged, and shared by every worker.
    let backend = nostream_storage::event_store::resolved_backend(&settings, false)
        .map_err(|error| DaemonError::Setup(format!("event store backend: {error}")))?;
    tracing::info!(backend = ?backend, "event store backend resolved");

    // The two bounds are the operator's; `from_settings` is where they are read.
    let mut relay_config = RelayConfig::from_settings(&settings);
    // The one environment read: the drain deadline is the operator's.
    relay_config.drain_timeout = nostream_relay::transport::drain_timeout();

    // The storage backend is not wired yet (the LMDB environment is a stub), so the relay
    // runs over seams that report `NotImplemented`; the wire itself is served in full.
    let service_stores = Arc::new(nostream_services::unavailable::stores());
    let wot: Arc<dyn nostream_relay::wot::WotGraph> = Arc::new(WotGraphService::new(
        Arc::clone(&settings),
        Arc::clone(&service_stores.events),
    ));
    let relay_keys = RelayKeySource::from_env();

    let relay = Relay::new(
        (*settings).clone(),
        Arc::new(nostream_relay::unavailable::stores()),
        wot,
        Arc::new(SystemClock),
        relay_keys.clone(),
        Arc::new(SystemRandom),
        relay_config,
    );

    let client =
        Arc::new(ReqwestClient::new().map_err(|error| DaemonError::Setup(error.to_string()))?);
    let http: Arc<dyn HttpClient> = client.clone();
    let fetch: Arc<dyn Nip05Fetch> = client;
    let context = ServiceContext {
        settings: Arc::clone(&settings),
        clock: Arc::new(SystemClock),
        random: Arc::new(SystemRandom),
        keys: Arc::new(relay_keys),
        stores: Arc::clone(&service_stores),
        hub: relay.hub(),
        http: Arc::clone(&http),
        fetch: Arc::clone(&fetch),
        config_dir: config_dir.clone(),
    };

    // R8: one `relay.restarted` row per process. A failure is logged, never fatal.
    if let Err(error) =
        nostream_services::services::operator_notification_service::enqueue_relay_restarted(
            &service_stores,
            env!("CARGO_PKG_VERSION"),
            port,
        )
        .await
    {
        match error {
            nostream_storage::StorageError::NotImplemented { module } => tracing::warn!(
                module,
                "the notification outbox is not wired; the relay.restarted notification was not enqueued"
            ),
            error => {
                tracing::warn!(error = %error, "unable to enqueue the relay.restarted notification");
            }
        }
    }

    // R12: the admin surface is composed from the pieces this function already built — the
    // same `Arc<ServiceStores>`, the same HTTP and NIP-05 seams, `SECRET` as a value.
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let admin_paths = SettingsPaths::from_config_dir(&cwd, config_dir.clone());
    let (admin_state, admin_router) = nostreamd::admin_http::compose(
        admin_paths,
        cwd.join("resources"),
        Arc::clone(&service_stores),
        Arc::clone(&http),
        Arc::clone(&fetch),
    )?;
    nostreamd::admin_http::warn_when_the_surface_has_no_secret(&admin_state);

    tracing::info!(at = %acceptor.local_addr(), "the acceptor is listening");

    let connection_shutdown = shutdown.clone();
    let http_fallback = nostreamd::admin_http::AdminHttp::new(admin_router);
    let accept_task =
        tokio::spawn(acceptor.run_with_http(relay, http_fallback, connection_shutdown));

    let heartbeat_state = Arc::clone(&admin_state);
    let heartbeat_shutdown = shutdown.clone();
    let heartbeat_task = tokio::spawn(async move {
        nostreamd::admin_http::publish_heartbeats(heartbeat_state, heartbeat_shutdown).await
    });

    let workers_context = context.clone();
    let workers_shutdown = shutdown.clone();
    let workers_task = tokio::spawn(async move {
        nostreamd::workers::spawn_workers(workers_context, workers_shutdown).await
    });

    let tor_context = context.clone();
    let tor_shutdown = shutdown.clone();
    let tor_task = tokio::spawn(async move {
        nostreamd::workers::spawn_tor(tor_context, tor_shutdown, port).await
    });

    wait_for_signal().await;
    tracing::info!("signal received; draining");

    shutdown.begin_draining();
    let accept_result = accept_task
        .await
        .map_err(|error| DaemonError::Setup(format!("acceptor task: {error}")));
    let workers_result = workers_task
        .await
        .map_err(|error| DaemonError::Setup(format!("workers task: {error}")))
        .and_then(std::convert::identity);
    let tor_result = tor_task
        .await
        .map_err(|error| DaemonError::Setup(format!("tor task: {error}")))
        .and_then(std::convert::identity);
    let heartbeat_result = heartbeat_task
        .await
        .map_err(|error| DaemonError::Setup(format!("heartbeat task: {error}")));
    for (name, result) in [
        ("acceptor", accept_result),
        ("workers", workers_result),
        ("tor", tor_result),
        ("heartbeats", heartbeat_result),
    ] {
        if let Err(error) = result {
            tracing::warn!(task = name, error = %error, "background task ended with an error");
        }
    }

    tracing::info!("drained; exiting");
    Ok(ExitCode::SUCCESS)
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        // A failing signal registration is a process setup failure, not a runtime event:
        // warn and fall back to a plain ctrl-c wait so the daemon still drains.
        let sigint = signal(SignalKind::interrupt());
        let sigterm = signal(SignalKind::terminate());
        if let (Ok(mut sigint), Ok(mut sigterm)) = (sigint, sigterm) {
            tokio::select! {
                _ = sigint.recv() => {}
                _ = sigterm.recv() => {}
            }
            return;
        }
        tracing::warn!("signal registration failed; falling back to ctrl-c");
        let _ = tokio::signal::ctrl_c().await;
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
