//! The CLI error type. `anyhow` lives in the binary; the library keeps its own type.

use thiserror::Error;

/// Errors raised by the CLI library.
#[derive(Debug, Error)]
pub enum CliError {
    /// A Phase 1 stub. The module names the call that is not implemented yet.
    #[error("not implemented in Phase 1 (job 005): {module}")]
    NotImplemented { module: &'static str },

    /// A config file or path could not be read.
    #[error("{0}")]
    Config(String),
}
