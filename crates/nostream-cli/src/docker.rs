//! The docker supervisor. Mirrors `src/cli/utils/docker.ts`.

use crate::error::CliError;

/// Phase 1 stub — job 005; will run compose commands against the deployment; see `src/cli/utils/docker.ts`.
pub fn compose(_args: &[String]) -> Result<String, CliError> {
    Err(CliError::NotImplemented {
        module: "cli::docker::compose",
    })
}
