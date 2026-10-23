//! `nostreamd` — the relay daemon entry point.
//!
//! `anyhow` is allowed here (binaries only, spec D10); the library carries the typed errors.

use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use nostream_config::SettingsPaths;
use nostream_core::clock::SystemClock;
use nostream_core::lifecycle::ShutdownState;
use nostream_relay::{Relay, relay_key::RelayKeySource, unavailable};
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

    telemetry::init(
        &outcome.settings,
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

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| DaemonError::Setup(format!("tokio runtime: {error}")))?;

    let settings = outcome.settings;

    runtime.block_on(async move { serve(listen, settings).await })
}

async fn serve(
    listen: SocketAddr,
    settings: nostream_config::Settings,
) -> Result<ExitCode, DaemonError> {
    let acceptor = nostreamd::Acceptor::bind(listen).await?;
    let shutdown = ShutdownState::new();

    // The storage backend is not wired yet (the LMDB environment is a stub), so the relay
    // runs over seams that report `NotImplemented`; the wire itself is served in full.
    let relay = Relay::new(
        settings,
        std::sync::Arc::new(unavailable::stores()),
        std::sync::Arc::new(SystemClock),
        RelayKeySource::from_env(),
        std::sync::Arc::new(nostream_core::random::SystemRandom),
        nostream_relay::relay::RelayConfig::default(),
    );

    tracing::info!(at = %acceptor.local_addr(), "the acceptor is listening");

    let connection_shutdown = shutdown.clone();
    let accept_task = tokio::spawn(acceptor.run(relay, connection_shutdown));
    let workers_task = tokio::spawn(async { nostreamd::workers::spawn_workers().await });
    let tor_task = tokio::spawn(async { nostreamd::workers::spawn_tor().await });

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
