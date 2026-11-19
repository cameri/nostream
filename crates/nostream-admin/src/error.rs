//! The admin error type.
//!
//! A controller returns [`AdminError`] and the router's wrapper renders it: an implementation
//! gap is a `NotImplemented` variant (`CLAUDE.md`'s convention for an unwired subsystem), and
//! every other variant is a handler failure, which the capture's `withAdminController` turns
//! into `500 {"error":"Internal Server Error"}`.

use std::path::PathBuf;

use nostream_config::ConfigError;
use nostream_storage::StorageError;
use thiserror::Error;

/// Errors raised by `nostream-admin`.
#[derive(Debug, Error)]
pub enum AdminError {
    /// A Phase 2 stub. The module names the call that is not implemented yet.
    #[error("not implemented in Phase 1 (job 005): {module}")]
    NotImplemented { module: &'static str },

    /// A request failed authentication.
    #[error("admin request is unauthorised: {0}")]
    Unauthorised(String),

    /// A request body is not valid.
    #[error("admin request is invalid: {0}")]
    Invalid(String),

    /// A settings file could not be read, written or validated.
    #[error(transparent)]
    Config(#[from] ConfigError),

    /// A repository call failed.
    #[error(transparent)]
    Storage(#[from] StorageError),

    /// A file the admin surface owns could not be read or written.
    #[error("failed to access {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// A value the surface needs is absent or malformed.
    #[error("{0}")]
    Internal(String),
}
