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

    // R9: payments cannot be enabled without a usable SECRET. This is the capture's one
    // startup refusal (`src/app/app.ts:86-94`) and it exits 1, not `InvalidSettings`' 2.
    if payments_enabled(&settings) && secret_missing() {
        return Err(DaemonError::MissingSecret);
    }

    telemetry::init(
        &settings,
        telemetry::resolve_filter(cli.log_level.as_deref()),
    )
    .map_err(|error| DaemonError::Setup(error.to_string()))?;

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
    let config_dir = paths.config_base_dir;

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

    let client = Arc::new(ReqwestClient::new());
    let http: Arc<dyn HttpClient> = client.clone();
    let fetch: Arc<dyn Nip05Fetch> = client;
    let context = ServiceContext {
        settings: Arc::clone(&settings),
        clock: Arc::new(SystemClock),
        random: Arc::new(SystemRandom),
        keys: Arc::new(relay_keys),
        stores: Arc::clone(&service_stores),
        hub: relay.hub(),
        http,
        fetch,
        config_dir,
    };

    // R8: one `relay.restarted` row per process. A failure is logged, never fatal.
    let payload = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "relayPort": port,
    });
    if let Err(error) = context
        .stores
        .notification_outbox
        .enqueue("relay.restarted", &payload)
        .await
    {
        tracing::warn!(error = %error, "unable to enqueue the relay.restarted notification");
    }

    tracing::info!(at = %acceptor.local_addr(), "the acceptor is listening");

    let connection_shutdown = shutdown.clone();
    let accept_task = tokio::spawn(acceptor.run(relay, connection_shutdown));

    let workers_context = context.clone();
    let workers_shutdown = shutdown.clone();
    let workers_task = tokio::spawn(async move {
        nostreamd::workers::spawn_workers(workers_context, workers_shutdown).await
    });

    let tor_context = context.clone();
    let tor_task =
        tokio::spawn(async move { nostreamd::workers::spawn_tor(tor_context, port).await });

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
    for (name, result) in [
        ("acceptor", accept_result),
        ("workers", workers_result),
        ("tor", tor_result),
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
