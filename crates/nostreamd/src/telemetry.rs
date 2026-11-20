//! Telemetry: a tracing subscriber, plus an OTLP span exporter behind the `otlp` feature (the
//! Phase-5 OTEL exporter; the tracing-otlp crate named in the old spec does not exist — the
//! deviation is recorded in `docs/rewrite/decisions/0001-runtime-and-telemetry.md`).
//!
//! The subscriber's writer is the caller's to choose, because one of the daemon's two modes
//! carries a protocol on stdout: the relay path logs there as it always has, and
//! `--mcp-stdio` logs to stderr so no log line can corrupt the JSON-RPC stream (R18). The
//! choice is made at initialisation, not bolted on afterwards — the subscriber is installed with
//! `try_init`, so a second one is a silent no-op that reports `Err`.

use nostream_config::Settings;
use tracing_subscriber::EnvFilter;

use crate::error::DaemonError;

/// Where the installed subscriber writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogWriter {
    /// The relay path's destination, where the daemon has always logged.
    Stdout,
    /// The stdio MCP mode's: stdout carries the protocol.
    Stderr,
}

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

/// Installs the global subscriber from the settings, writing where `writer` says.
///
/// The OTLP endpoint comes from `OTEL_EXPORTER_OTLP_ENDPOINT` (the OTEL SDK convention), not
/// from a settings field: the capture's settings carry no telemetry section.
pub fn init(settings: &Settings, filter: EnvFilter, writer: LogWriter) -> Result<(), DaemonError> {
    let _ = settings;
    #[cfg(feature = "otlp")]
    {
        if std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").is_ok() {
            // The exporter wiring lands with Phase 5; the feature gate and the env convention
            // are what Phase 1 pins.
            return init_otlp();
        }
    }
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false);
    match writer {
        LogWriter::Stdout => builder.try_init(),
        LogWriter::Stderr => builder.with_writer(std::io::stderr).try_init(),
    }
    .map_err(|error| DaemonError::Setup(format!("telemetry: {error}")))
}

#[cfg(feature = "otlp")]
fn init_otlp() -> Result<(), DaemonError> {
    Err(DaemonError::NotImplemented {
        module: "nostreamd::telemetry::init_otlp",
    })
}
