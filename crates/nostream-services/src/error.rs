//! The services' error type.

use thiserror::Error;

/// Errors raised by `nostream-services`.
#[derive(Debug, Error)]
pub enum ServicesError {
    /// A Phase 1 stub. The module names the call that is not implemented yet.
    #[error("not implemented in Phase 1 (job 005): {module}")]
    NotImplemented { module: &'static str },

    /// A payment processor refused a request.
    #[error("payment processor error: {0}")]
    Payment(String),
}
