//! The relay's error type.

use thiserror::Error;

/// Errors raised by `nostream-relay`.
#[derive(Debug, Error)]
pub enum RelayError {
    /// A Phase 1 stub. The module names the call that is not implemented yet.
    #[error("not implemented in Phase 1 (job 005): {module}")]
    NotImplemented { module: &'static str },

    /// A client message could not be decoded or is malformed.
    #[error("invalid message: {0}")]
    InvalidMessage(String),

    /// The socket is closing under drain.
    #[error("the relay is draining and refuses new work")]
    Draining,
}
