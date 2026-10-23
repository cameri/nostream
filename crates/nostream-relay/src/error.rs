//! The relay's error type.

use nostream_storage::StorageError;
use thiserror::Error;

/// Errors raised by `nostream-relay`.
#[derive(Debug, Error)]
pub enum RelayError {
    /// A stub. The module names the call that is not implemented yet and the label on the
    /// item names the job that will fill it.
    #[error("not implemented: {module}")]
    NotImplemented { module: &'static str },

    /// A client message could not be decoded or is malformed.
    #[error("invalid message: {0}")]
    InvalidMessage(String),

    /// A repository call failed.
    #[error(transparent)]
    Storage(#[from] StorageError),

    /// The rate limiter's in-process store could not be read or written.
    #[error("rate limiter store unavailable: {0}")]
    RateLimiter(String),

    /// Settings the relay needs are missing or malformed.
    #[error("relay configuration: {0}")]
    Configuration(String),

    /// The signed websocket handshake failed.
    #[error("websocket handshake: {0}")]
    Handshake(String),
}
