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
use nostream_relay::relay::{refusal_message, refused_bounds};

use crate::error::DaemonError;

/// Applies the gate to one load outcome: report the findings, decide whether they are fatal.
pub fn apply_settings_gate(outcome: &LoadOutcome, check: bool) -> Result<(), DaemonError> {
    // `settings` is what the relay would run with, so on a rejected document it is the shipped
    // defaults ("                    format!(\"failed to load user settings: {error}\"),",
    // `crates/nostream-config/src/load.rs:402`) and a walk of it would describe the document's own
    // values rather than the operator's. The guard keeps a substitution from being read as a
    // violation; it cannot recover the operator's leaf, which is why a rejected document reports
    // the schema fault and nothing else.
    if !outcome.used_defaults {
        for (setting, reason) in refused_bounds(&outcome.settings) {
            eprintln!("{}", refusal_message(setting, reason));
        }
    }

    if outcome.issues.is_empty() {
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
