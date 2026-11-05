//! The background workers. Mirrors the capture's cluster primary and its worker types
//! (`src/app/app.ts:140-186`, `src/index.ts:11-27`): the maintenance pass and one DVM
//! orchestrator per configured worker run under [`Supervisor`]; Tor is a one-shot startup
//! task.

use nostream_core::lifecycle::ShutdownState;
use nostream_services::ServiceContext;
use nostream_services::scheduler::Supervisor;
use nostream_services::tor::{TorConfig, ensure_hidden_service};
use nostream_services::workers::{dvm_orchestrator, maintenance};

use crate::error::DaemonError;

/// Starts the registered workers and returns when the supervisor drains, or earlier if every
/// worker has finished on its own (both registered kinds loop until the drain).
///
/// Registered: one maintenance worker, and one DVM orchestrator per `dvm.workers[i]`. The
/// relay-monitor worker is issue #865's and is not registered here.
pub async fn spawn_workers(
    context: ServiceContext,
    shutdown: ShutdownState,
) -> Result<(), DaemonError> {
    let mut supervisor = Supervisor::new(shutdown);

    let (_, maintenance_spec) = maintenance::maintenance_worker(&context)
        .map_err(|error| worker_setup("maintenance worker", error))?;
    supervisor.register(maintenance_spec);

    for spec in dvm_orchestrator::dvm_specs(&context)
        .map_err(|error| worker_setup("dvm orchestrator", error))?
    {
        supervisor.register(spec);
    }

    tracing::info!(workers = supervisor.len(), "workers registered");

    supervisor
        .run()
        .await
        .map_err(|error| DaemonError::Setup(format!("supervisor: {error}")))
}

/// A worker that cannot be built is reported where it happens: `serve` only joins the task
/// after a drain, so without this the operator would see the failure after SIGINT.
fn worker_setup(role: &str, error: nostream_services::ServicesError) -> DaemonError {
    let error = DaemonError::Setup(format!("{role}: {error}"));
    tracing::error!(%error, "a background worker could not be built");

    error
}

/// One Tor bootstrap attempt. A missing `TOR_HOST`, an unreachable control port and a refused
/// `ADD_ONION` all log `Tor hidden service: disabled`; the capture never fails startup on Tor
/// (`src/app/app.ts:204-212`).
pub async fn spawn_tor(context: ServiceContext, relay_port: u16) -> Result<(), DaemonError> {
    let config = TorConfig::from_env(&context.config_dir, relay_port);

    match ensure_hidden_service(&config).await {
        nostream_services::tor::HiddenServiceOutcome::Enabled { service_id, port } => {
            tracing::info!("Tor hidden service: {service_id}:{port}");
        }
        nostream_services::tor::HiddenServiceOutcome::Disabled => {
            tracing::info!("Tor hidden service: disabled");
        }
    }

    Ok(())
}
