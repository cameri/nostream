//! The daemon's settings gate: the capture's fallback rule, applied once.
//!
//! A user configuration that cannot be read or does not validate never aborts the process:
//! `nostream_config::load` substitutes the shipped defaults and reports the findings. The
//! serve path logs every finding and continues on the defaults; `--check` is the one place
//! findings are fatal (exit 2), because its whole job is to report them.
//!
//! This module is also the workspace's one library-position writer to stdout/stderr *outside
//! the `tracing` subscriber*: every other write a library crate makes goes through `tracing`
//! and `telemetry::init`'s `tracing_subscriber::fmt()` layer (whose writer is stdout, and
//! whose output the `EnvFilter` governs). These three bypass that filter, so the rule that
//! keeps them honest is worth stating: output belongs to a process's entry point, and a
//! library that writes to a stream the caller does not drain can block it — a per-record
//! write stalls a whole subscription behind a full pipe. These writes are the operator report
//! of a single settings check, reached once from `run` before the relay exists, every one of
//! them newline-terminated (so each flushes per write). Nothing added here may run per
//! request, per message or per streamed record.

use nostream_config::LoadOutcome;
use nostream_relay::relay::{MAX_SETTING_BOUND, in_range};

use crate::error::DaemonError;

/// The two settings whose value the relay bounds at run time, with the default it falls back to.
/// A value out of range is not a schema fault — the key is valid and the number is a number — so
/// it is neither an issue nor fatal; but `--check` is where an operator looks before starting, so
/// a value about to be replaced is reported here rather than only at start-up (ADR 0008).
fn out_of_range_bounds(settings: &nostream_config::settings::Settings) -> Vec<(&'static str, u64)> {
    let mut dropped = Vec::new();
    if let Some(bytes) = settings.network.frame_memory_budget_bytes
        && !in_range(bytes)
    {
        dropped.push(("network.frameMemoryBudgetBytes", bytes));
    }
    if let Some(cap) = settings
        .limits
        .as_ref()
        .and_then(|limits| limits.connection.as_ref())
        .and_then(|connection| connection.max_connections_per_ip)
        && !in_range(cap)
    {
        dropped.push(("limits.connection.maxConnectionsPerIp", cap));
    }
    dropped
}

/// Applies the gate to one load outcome: report the findings, decide whether they are fatal.
pub fn apply_settings_gate(outcome: &LoadOutcome, check: bool) -> Result<(), DaemonError> {
    if outcome.issues.is_empty() {
        for (setting, value) in out_of_range_bounds(&outcome.settings) {
            eprintln!(
                "{setting}: {value} is above the {MAX_SETTING_BOUND} a bound accepts; \
                 the relay runs with its default"
            );
        }
        if check {
            println!("settings valid: 0 issues");
        }
        return Ok(());
    }

    for issue in &outcome.issues {
        eprintln!("{issue}");
    }
    if check {
        return Err(DaemonError::InvalidSettings {
            count: outcome.issues.len(),
        });
    }
    eprintln!(
        "nostreamd: continuing on the shipped defaults ({} issue(s) in the user settings)",
        outcome.issues.len()
    );
    Ok(())
}
