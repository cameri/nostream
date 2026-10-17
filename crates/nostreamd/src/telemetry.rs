//! Telemetry: a tracing subscriber to stdout, plus an OTLP span exporter behind the `otlp`
//! feature (the Phase-5 OTEL exporter; the tracing-otlp crate named in the old spec does not
//! exist — the deviation is recorded in `docs/rewrite/decisions/0001-runtime-and-telemetry.md`).

use nostream_config::Settings;

use crate::error::DaemonError;

/// Installs the global subscriber from the settings.
///
/// The OTLP endpoint comes from `OTEL_EXPORTER_OTLP_ENDPOINT` (the OTEL SDK convention), not
/// from a settings field: the capture's settings carry no telemetry section.
pub fn init(settings: &Settings) -> Result<(), DaemonError> {
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
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
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
