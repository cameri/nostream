//! The services' error type.

use nostream_storage::StorageError;
use thiserror::Error;

/// Errors raised by `nostream-services`.
#[derive(Debug, Error)]
pub enum ServicesError {
    /// A Phase 1 stub. The module names the call that is not implemented yet.
    #[error("not implemented in Phase 1 (job 005): {module}")]
    NotImplemented { module: &'static str },

    /// A processor, a service or the scheduler could not be built from its settings.
    #[error("{0}")]
    Configuration(String),

    /// A payment processor refused a request (`IPaymentsProcessor`'s errors).
    #[error("payment processor error: {0}")]
    Payment(String),

    /// A notification target refused or could not receive a message.
    #[error("{0}")]
    Notification(String),

    /// An imported event or input could not be accepted.
    #[error("{0}")]
    Import(String),

    /// The Tor control port refused or could not be reached.
    #[error("{0}")]
    Tor(String),

    /// A DVM job could not be dispatched or completed.
    #[error("{0}")]
    Dvm(String),

    /// An outbound HTTP request failed. `status` is the response's status when one arrived,
    /// which is what the invoice walk's 404 rule reads.
    #[error("{message}")]
    Http {
        status: Option<u16>,
        message: String,
    },

    /// A storage call failed.
    #[error(transparent)]
    Storage(#[from] StorageError),
}

impl ServicesError {
    /// The HTTP status a failed request carried, when one arrived.
    pub fn http_status(&self) -> Option<u16> {
        match self {
            Self::Http { status, .. } => *status,
            _ => None,
        }
    }
}
