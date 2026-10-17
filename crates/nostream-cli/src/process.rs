//! The process supervisor. Mirrors `src/cli/utils/process.ts`.

use crate::error::CliError;

/// Phase 1 stub — job 005; will spawn and supervise child processes; see `src/cli/utils/process.ts`.
pub fn spawn(_command: &str) -> Result<u32, CliError> {
    Err(CliError::NotImplemented {
        module: "cli::process::spawn",
    })
}
