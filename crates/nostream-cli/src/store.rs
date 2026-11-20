//! The store the CLI opens, from the settings' `eventStore.backend` and the command's
//! `--data-dir`.
//!
//! `nostream-cli` is a front end over the store, not a worker: it reads the settings the daemon
//! would read, opens the backend they name and closes it when the command is done. The LMDB
//! store is `<data-dir>/lmdb` — the same layout `migrate pg-to-lmdb --target` writes
//! (`crates/nostream-storage/src/backend.rs:47-52`) — and Postgres is the `DB_*` family, with
//! `DB_URI` winning when both are set (`src/database/client.ts`).

use std::path::{Path, PathBuf};
use std::time::Duration;

use nostream_config::Settings;
use nostream_core::EventStoreBackend;
use nostream_storage::repositories::{
    EventRepository, InviteCodeRepository, InvoiceRepository, UserRepository,
};
use nostream_storage::{LmdbBackend, StorageError, backend};

use crate::env_file::Environment;
use crate::error::CliError;

/// An opened store, one of the two shipped backends.
#[derive(Debug)]
pub enum Opened {
    Lmdb(Box<LmdbBackend>),
    Postgres(Box<nostream_storage::PostgresBackend>),
}

impl Opened {
    /// The event store, whatever backend answered.
    pub fn events(&self) -> &dyn EventRepository {
        match self {
            Self::Lmdb(backend) => backend.as_ref(),
            Self::Postgres(backend) => backend.as_ref(),
        }
    }

    /// The invite-code store.
    pub fn invites(&self) -> &dyn InviteCodeRepository {
        match self {
            Self::Lmdb(backend) => backend.as_ref(),
            Self::Postgres(backend) => backend.as_ref(),
        }
    }

    /// The invoice store.
    pub fn invoices(&self) -> &dyn InvoiceRepository {
        match self {
            Self::Lmdb(backend) => backend.as_ref(),
            Self::Postgres(backend) => backend.as_ref(),
        }
    }

    /// The user store.
    pub fn users(&self) -> &dyn UserRepository {
        match self {
            Self::Lmdb(backend) => backend.as_ref(),
            Self::Postgres(backend) => backend.as_ref(),
        }
    }
}

/// The backend the settings name, defaulting to Postgres (`configured_backend`).
pub fn selected_backend(settings: &Settings) -> EventStoreBackend {
    nostream_storage::event_store::configured_backend(settings)
}

/// Whether the environment names a Postgres server at all: `DB_URI` or `DB_HOST`, the two keys
/// whose absence the capture reads as "not configured".
///
/// The connection is assembled once, by
/// `PostgresBackend::from_lookup` over `nostream_storage::postgres`'s `master_options`:
/// `DB_URI` wins over the `DB_*` parts, the parts get the capture's defaults — **`localhost`
/// included**, when no `DB_HOST` is set — and every field reaches `PgConnectOptions` directly,
/// so no URL is composed and no credential is encoded. This presence rule is the CLI's own and
/// is deliberately **narrower** than that assembly: the capture's `DB_URI || DB_HOST` test is
/// what a script sees, so `DB_PORT`/`DB_USER` alone is refused with
/// `PostgreSQL is not configured (set DB_URI or DB_HOST)` rather than dialling the default host.
pub fn postgres_configured(env: &Environment) -> bool {
    env.get("DB_URI").is_some() || env.get("DB_HOST").is_some()
}

/// The path the LMDB store lives at, `<data-dir>/lmdb`.
pub fn lmdb_store_dir(data_dir: &Path) -> PathBuf {
    backend::store_dir(data_dir)
}

/// Opens the store the settings name.
///
/// With the lmdb backend and no `--data-dir` the command fails rather than inventing a root:
/// `the lmdb backend needs --data-dir <path>` (the thrown class, exit 1).
pub async fn open(
    settings: &Settings,
    data_dir: Option<&Path>,
    env: &Environment,
) -> Result<Opened, CliError> {
    match selected_backend(settings) {
        EventStoreBackend::Lmdb => {
            let Some(root) = data_dir else {
                return Err(CliError::command(
                    "the lmdb backend needs --data-dir <path>",
                ));
            };
            let store = LmdbBackend::open(root)
                .await
                .map_err(|error| storage_error(&error))?;
            Ok(Opened::Lmdb(Box::new(store)))
        }
        EventStoreBackend::Postgres => {
            if !postgres_configured(env) {
                return Err(CliError::command(
                    "PostgreSQL is not configured (set DB_URI or DB_HOST)",
                ));
            }
            let store = nostream_storage::PostgresBackend::from_lookup(&|key: &str| env.get(key))
                .await
                .map_err(|error| storage_error(&error))?;
            Ok(Opened::Postgres(Box::new(store)))
        }
    }
}

/// Opens the store, but gives up after `budget` — the shape `info` needs, where an unreachable
/// host is reported as a missing number rather than as a failure.
pub async fn open_within(
    settings: &Settings,
    data_dir: Option<&Path>,
    env: &Environment,
    budget: Duration,
) -> Option<Opened> {
    tokio::time::timeout(budget, open(settings, data_dir, env))
        .await
        .ok()?
        .ok()
}

/// Renders a storage failure the way a command reports it.
pub fn storage_error(error: &StorageError) -> CliError {
    CliError::command(error.to_string())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    fn environment(pairs: &[(&str, &str)]) -> Environment {
        let content: String = pairs
            .iter()
            .map(|(key, value)| format!("{key}={value}\n"))
            .collect();
        let file = crate::env_file::parse_values(&content);
        // `Environment::load` reads the process environment first; a test that wants the file
        // layer alone builds the struct it would hold.
        crate::env_file::Environment::from_values(file)
    }

    #[test]
    fn the_presence_rule_is_either_key() {
        assert!(postgres_configured(&environment(&[(
            "DB_URI",
            "postgres://a@b/c"
        )])));
        assert!(postgres_configured(&environment(&[(
            "DB_HOST",
            "db.internal"
        )])));
        // The rule is narrower than the assembly on purpose: `master_options` would default the
        // host to `localhost`, and the capture's `DB_URI || DB_HOST` test — which is what this
        // rule reproduces — refuses the parts alone instead.
        assert!(!postgres_configured(&environment(&[
            ("DB_PORT", "5432"),
            ("DB_USER", "postgres"),
        ])));
    }
}
