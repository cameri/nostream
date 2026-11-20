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

/// The Postgres connection string the environment describes, or `None` when neither `DB_URI` nor
/// `DB_HOST` is set.
///
/// `DB_URI` wins. Otherwise the parts are assembled into a URL, with the user and the password
/// percent-encoded: a password holding `@` or `/` is common, and a URL that mis-parses it fails
/// as a wrong host rather than as a wrong password.
pub fn postgres_url(env: &Environment) -> Option<String> {
    if let Some(uri) = env.get("DB_URI") {
        return Some(uri);
    }

    let host = env.get("DB_HOST")?;
    let port = env.get("DB_PORT").unwrap_or_else(|| "5432".to_owned());
    let user = env.get("DB_USER").unwrap_or_else(|| "postgres".to_owned());
    let database = env.get("DB_NAME").unwrap_or_else(|| "postgres".to_owned());

    let credentials = match env.get("DB_PASSWORD") {
        Some(password) => format!("{}:{}@", encode_userinfo(&user), encode_userinfo(&password)),
        None => format!("{}@", encode_userinfo(&user)),
    };

    Some(format!(
        "postgres://{credentials}{host}:{port}/{}",
        encode_userinfo(&database)
    ))
}

/// Percent-encodes the characters that would end a userinfo or a path segment.
fn encode_userinfo(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b':' => {
                encoded.push(char::from(byte));
            }
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
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
            let Some(url) = postgres_url(env) else {
                return Err(CliError::command(
                    "PostgreSQL is not configured (set DB_URI or DB_HOST)",
                ));
            };
            let store = nostream_storage::PostgresBackend::connect(&url)
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
    fn db_uri_wins_over_the_parts() {
        let env = environment(&[("DB_URI", "postgres://a@b/c"), ("DB_HOST", "ignored")]);
        assert_eq!(postgres_url(&env).as_deref(), Some("postgres://a@b/c"));
    }

    #[test]
    fn the_parts_build_a_url_with_the_defaults() {
        let env = environment(&[("DB_HOST", "db.internal")]);
        assert_eq!(
            postgres_url(&env).as_deref(),
            Some("postgres://postgres@db.internal:5432/postgres")
        );
    }

    #[test]
    fn a_password_is_percent_encoded() {
        let env = environment(&[
            ("DB_HOST", "db.internal"),
            ("DB_PORT", "6543"),
            ("DB_USER", "nostr"),
            ("DB_PASSWORD", "p@ss/word"),
            ("DB_NAME", "relay"),
        ]);
        assert_eq!(
            postgres_url(&env).as_deref(),
            Some("postgres://nostr:p%40ss%2Fword@db.internal:6543/relay")
        );
    }

    #[test]
    fn no_db_configuration_is_no_url() {
        assert_eq!(postgres_url(&environment(&[])), None);
    }
}
