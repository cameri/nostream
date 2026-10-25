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
use nostream_relay::relay::{BoundRefusal, refused_bounds};

use crate::error::DaemonError;

/// Prints one refused bound. A zero is the documented "use the default", so its line says only
/// that; an over-ceiling value names the ceiling. Neither says the relay falls back to *this key's*
/// default on top of a schema fault, because it would not: a rejected document is replaced whole —
/// "            settings: defaults_settings," (`crates/nostream-config/src/load.rs:421`).
fn report_refused_bound(setting: &str, reason: BoundRefusal) {
    match reason {
        BoundRefusal::Zero => {
            eprintln!("{setting}: 0 means the default, and the relay runs with it");
        }
        BoundRefusal::AboveCeiling(ceiling) => {
            eprintln!("{setting}: above the {ceiling} a bound accepts; the key's value is ignored")
        }
    }
}

/// Applies the gate to one load outcome: report the findings, decide whether they are fatal.
pub fn apply_settings_gate(outcome: &LoadOutcome, check: bool) -> Result<(), DaemonError> {
    // Independent of the schema verdict: an unrelated typo must not hide a range report, and a
    // rejected document has already been replaced whole, so the report says what happened to the
    // number rather than what the relay runs with.
    for (setting, reason) in refused_bounds(&outcome.settings) {
        report_refused_bound(setting, reason);
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
