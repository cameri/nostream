//! The admin error type.

use thiserror::Error;

/// Errors raised by `nostream-admin`.
#[derive(Debug, Error)]
pub enum AdminError {
    /// A Phase 1 stub. The module names the call that is not implemented yet.
    #[error("not implemented in Phase 1 (job 005): {module}")]
    NotImplemented { module: &'static str },

    /// A request failed authentication.
    #[error("admin request is unauthorised: {0}")]
    Unauthorised(String),

    /// A request body is not valid.
    #[error("admin request is invalid: {0}")]
    Invalid(String),
}
