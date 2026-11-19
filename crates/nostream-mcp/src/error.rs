//! The MCP server's error type.
//!
//! A tool answers its failures as `isError: true` results, so these variants exist to be
//! rendered into a caller-visible text rather than matched by a status code: a pipe carries no
//! status, and a caller that reads `Tool result missing due to internal error` learns nothing.
//! `Display` is therefore the operator-facing message, and the store's own message is passed
//! through unchanged (R19).

use nostream_admin::AdminError;
use nostream_storage::StorageError;
use thiserror::Error;

/// Errors raised by `nostream-mcp`.
#[derive(Debug, Error)]
pub enum McpError {
    /// The admin state could not be read: the settings files, the audit file or the write path.
    #[error(transparent)]
    Admin(#[from] AdminError),

    /// A repository call failed. Its message is the backend's own, verbatim (R19).
    #[error(transparent)]
    Storage(#[from] StorageError),

    /// A tool's arguments are not the shape its `inputSchema` states.
    #[error("the tool's arguments could not be read: {0}")]
    Arguments(String),

    /// A criterion the tool refuses before it reads: an id or author that is not a
    /// 4-to-64-character hex prefix, more criteria than one call may carry, or a page size
    /// outside its bound.
    #[error("{0}")]
    Criterion(String),

    /// A payload the tool built could not be serialised.
    #[error("the payload could not be serialised: {0}")]
    Serialise(#[from] serde_json::Error),
}
