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

    /// The import could not run: a bad argument, a missing file or a storage failure.
    #[error("{0}")]
    Import(String),

    /// The migration could not run: a refused row, an unusable manifest or a store that would
    /// not open.
    #[error("{0}")]
    Migrate(String),
}
