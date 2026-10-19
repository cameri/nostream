//! The storage error type.

use thiserror::Error;

/// Errors raised by `nostream-storage`.
#[derive(Debug, Error)]
pub enum StorageError {
    /// A Phase 1 stub. The module names the call that is not implemented yet.
    #[error("not implemented in Phase 1 (job 005): {module}")]
    NotImplemented { module: &'static str },

    /// A database operation failed. The driver's message names the statement class for an
    /// operator; callers must not match on its text.
    #[error("database operation failed: {0}")]
    Database(#[from] sqlx::Error),

    /// The embedded migrator could not apply the schema.
    #[error("database migration failed: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),

    /// A caller violated a repository precondition.
    #[error("invalid argument: {message}")]
    InvalidArgument { message: &'static str },

    /// A column held a value the row type cannot represent, such as an unknown enum
    /// spelling or a malformed tag document.
    #[error("{table}.{column} holds a value the row type cannot represent: {value}")]
    InvalidRow {
        table: &'static str,
        column: &'static str,
        value: String,
    },

    /// An integer column held a value outside its Rust range (a negative kind, an id that
    /// is not 32 bytes).
    #[error("{column} is out of range: {value}")]
    ValueOutOfRange { column: &'static str, value: String },

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

#[cfg(test)]
mod tests {
    #![allow(clippy::panic)]

    use super::*;

    #[test]
    fn an_invalid_row_names_its_column_and_value() {
        let error = StorageError::InvalidRow {
            table: "invoices",
            column: "status",
            value: "refunded".to_owned(),
        };
        assert_eq!(
            error.to_string(),
            "invoices.status holds a value the row type cannot represent: refunded"
        );
    }

    #[test]
    fn an_out_of_range_value_names_the_column() {
        let error = StorageError::ValueOutOfRange {
            column: "event_kind",
            value: "-1".to_owned(),
        };
        assert_eq!(error.to_string(), "event_kind is out of range: -1");
    }

    #[test]
    fn an_invalid_argument_carries_the_capture_message() {
        let error = StorageError::InvalidArgument {
            message: "Filters cannot be empty",
        };
        assert_eq!(
            error.to_string(),
            "invalid argument: Filters cannot be empty"
        );
    }

    #[test]
    fn a_database_error_keeps_the_drivers_message() {
        let error = StorageError::from(sqlx::Error::RowNotFound);
        assert_eq!(
            error.to_string(),
            "database operation failed: no rows returned by a query that expected to return at least one row"
        );
    }
}
