//! The daemon's error type.

use thiserror::Error;

/// Errors raised by `nostreamd`.
#[derive(Debug, Error)]
pub enum DaemonError {
    /// A Phase 1 stub. The module names the call that is not implemented yet.
    #[error("not implemented in Phase 1 (job 005): {module}")]
    NotImplemented { module: &'static str },

    /// A socket or file the daemon needs could not be opened.
    #[error("daemon setup failed: {0}")]
    Setup(String),

    /// Settings failed validation; the daemon refuses to start.
    #[error("settings invalid: {count} issues")]
    InvalidSettings { count: usize },

    /// Payments are enabled and `SECRET` is unset, empty or the shipped placeholder
    /// (`src/app/app.ts:86-94`). The message is the capture's.
    #[error("Please configure the secret using the SECRET environment variable.")]
    MissingSecret,
}
