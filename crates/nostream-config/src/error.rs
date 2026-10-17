//! Errors that abort a settings load. Validation findings are not errors: they are
//! [`crate::Issue`] values, because the capture's validator never throws.

use std::path::PathBuf;

use thiserror::Error;

/// A settings file could not be read, parsed or interpreted.
#[derive(Debug, Error)]
pub enum ConfigError {
    /// A settings or defaults file could not be read.
    #[error("failed to read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// A YAML or JSON file is not valid.
    #[error("failed to parse {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_yaml::Error,
    },

    /// A JSON settings file is not valid.
    #[error("failed to parse {path}: {source}")]
    ParseJson {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },

    /// The document is valid YAML but does not fit the typed schema.
    #[error("settings do not fit the typed schema: {0}")]
    Typed(#[from] serde_yaml::Error),

    /// The redaction walk dropped a subtree it was handed; never expected.
    #[error("redaction dropped the notifications subtree")]
    RedactionDroppedSubtree,

    /// The configured settings location exists but is not a directory.
    #[error("settings path {path} exists but is not a directory")]
    NotADirectory { path: std::path::PathBuf },

    /// The defaults document is not a mapping.
    #[error("{path} does not contain a settings mapping")]
    NotAMapping { path: PathBuf },
}
