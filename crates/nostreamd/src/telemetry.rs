//! Telemetry: a tracing subscriber to stdout, plus an OTLP span exporter behind the `otlp`
//! feature (the Phase-5 OTEL exporter; the tracing-otlp crate named in the old spec does not
//! exist — the deviation is recorded in `docs/rewrite/decisions/0001-runtime-and-telemetry.md`).

use nostream_config::Settings;
use tracing_subscriber::EnvFilter;

use crate::error::DaemonError;

/// Resolves the log filter: `--log-level` first, then `LOG_LEVEL`, then `RUST_LOG`, else
/// INFO. `EnvFilter::from_default_env` alone would read only `RUST_LOG` and default to
/// ERROR, which silences the daemon's own startup lines.
pub fn resolve_filter(cli_level: Option<&str>) -> EnvFilter {
    if let Some(level) = cli_level {
        return EnvFilter::try_new(level).unwrap_or_else(|_| EnvFilter::new("info"));
    }
    if let Some(filter) = std::env::var_os("LOG_LEVEL")
        .and_then(|value| value.into_string().ok())
        .and_then(|level| EnvFilter::try_new(level).ok())
    {
        return filter;
    }
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))
}

/// Installs the global subscriber from the settings.
///
/// The OTLP endpoint comes from `OTEL_EXPORTER_OTLP_ENDPOINT` (the OTEL SDK convention), not
/// from a settings field: the capture's settings carry no telemetry section.
pub fn init(settings: &Settings, filter: EnvFilter) -> Result<(), DaemonError> {
    let _ = settings;
    #[cfg(feature = "otlp")]
    {
        if std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").is_ok() {
            // The exporter wiring lands with Phase 5; the feature gate and the env convention
            // are what Phase 1 pins.
            return init_otlp();
        }
    }
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init()
        .map_err(|error| DaemonError::Setup(format!("telemetry: {error}")))
}

#[cfg(feature = "otlp")]
fn init_otlp() -> Result<(), DaemonError> {
    Err(DaemonError::NotImplemented {
        module: "nostreamd::telemetry::init_otlp",
    })
}
