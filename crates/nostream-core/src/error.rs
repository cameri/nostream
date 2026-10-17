//! The crate's error type. Every library crate in this workspace names its own.

use thiserror::Error;

/// Errors raised by `nostream-core`.
#[derive(Debug, Error)]
pub enum CoreError {
    /// A Phase 1 stub. The module names the call that is not implemented yet.
    #[error("not implemented in Phase 1 (job 005): {module}")]
    NotImplemented { module: &'static str },

    /// The event violates the base schema (id/sig length, kind range, tag shape).
    #[error("invalid event: {0}")]
    InvalidEvent(String),

    /// A wire frame could not be decoded into a known message.
    #[error("invalid message: {0}")]
    InvalidMessage(String),
}
