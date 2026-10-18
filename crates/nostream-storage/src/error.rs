//! The storage error type.

use thiserror::Error;

/// Errors raised by `nostream-storage`.
#[derive(Debug, Error)]
pub enum StorageError {
    /// A Phase 1 stub. The module names the call that is not implemented yet.
    #[error("not implemented in Phase 1 (job 005): {module}")]
    NotImplemented { module: &'static str },

    /// An LMDB environment or transaction failed.
    #[error("lmdb operation failed: {0}")]
    Lmdb(#[from] heed::Error),

    /// An LMDB environment could not be opened at the requested path.
    #[error("failed to open the lmdb environment at {path}: {source}")]
    OpenLmdb {
        path: std::path::PathBuf,
        #[source]
        source: heed::Error,
    },

    /// A value must be valid UTF-8 to be stored through the string codecs.
    #[error("lmdb values must be valid utf-8")]
    NotUtf8,

    /// The environment's data directory could not be created.
    #[error("failed to create {path}: {source}")]
    CreateDirectory {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// An inherited backend env var named a backend that does not exist
    /// (`src/utils/event-store.ts` `Unsupported ${source} "${value}"`).
    #[error("Unsupported {env} \"{value}\". Supported backends: postgres, lmdb")]
    UnsupportedBackend { value: String, env: &'static str },
}
