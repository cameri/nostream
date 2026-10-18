//! The daemon's settings gate: the capture's fallback rule, applied once.
//!
//! A user configuration that cannot be read or does not validate never aborts the process:
//! `nostream_config::load` substitutes the shipped defaults and reports the findings. The
//! serve path logs every finding and continues on the defaults; `--check` is the one place
//! findings are fatal (exit 2), because its whole job is to report them.

use nostream_config::LoadOutcome;

use crate::error::DaemonError;

/// Applies the gate to one load outcome: report the findings, decide whether they are fatal.
pub fn apply_settings_gate(outcome: &LoadOutcome, check: bool) -> Result<(), DaemonError> {
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
