//! The Postgres backend: a pooled implementation of the nine repository traits, the
//! serializable transaction that spans users, invoices and the outbox, and the embedded
//! migrator. Mirrors `src/database/client.ts`, `src/database/transaction.ts` and the nine
//! files under `src/repositories/`.
//!
//! Queries are composed at runtime (`sqlx::query` with explicit `Row::try_get`
//! conversions), never through `query!`/`query_as!`: CI has no database to check the
//! macros against, and the event queries are dynamically composed.

mod events;
mod invoices;
mod metadata;
mod notifications;
mod repository;
mod rows;
mod sql;
mod users;

use std::env;
use std::sync::Arc;
use std::time::Duration;

use nostream_config::Settings;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use sqlx::{Postgres, Transaction};

use crate::error::StorageError;

pub(crate) use sql::{Arg, Args, EventQuery, Gates, Nip50Gate};

/// The default `nip50.language` when the settings leave it out (`simple`, as the capture's
/// FTS index is built).
pub(crate) const DEFAULT_TS_CONFIG: &str = "simple";
/// The default `nip50.maxQueryLength` (`src/repositories/event-repository.ts:50-52`).
pub(crate) const DEFAULT_MAX_SEARCH_QUERY_LENGTH: u64 = 256;
/// The capture's default page size (`DEFAULT_FILTER_LIMIT`).
pub(crate) const DEFAULT_FILTER_LIMIT: u64 = 500;
/// The retention batch size (`RETENTION_BATCH_SIZE`).
pub(crate) const RETENTION_BATCH_SIZE: u64 = 1000;

/// A pooled Postgres backend with the master pool and, when configured, a read replica.
#[derive(Debug, Clone)]
pub struct PostgresBackend {
    master: PgPool,
    reader: PgPool,
    settings: Option<Arc<Settings>>,
}

/// The connection settings one pool is built from, resolved from the environment exactly
/// as `src/database/client.ts:31-92` resolves them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConnectParts {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub database: String,
}

impl ConnectParts {
    fn options(&self) -> PgConnectOptions {
        let mut options = PgConnectOptions::new()
            .host(&self.host)
            .port(self.port)
            .username(&self.username)
            .database(&self.database);
        if let Some(password) = &self.password {
            options = options.password(password);
        }
        options
    }
}

/// The pool bounds one backend is built with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PoolBounds {
    pub min_connections: u32,
    pub max_connections: u32,
    pub acquire_timeout_ms: u64,
}

impl Default for PoolBounds {
    fn default() -> Self {
        Self {
            min_connections: 0,
            max_connections: 3,
            acquire_timeout_ms: 60_000,
        }
    }
}

impl PostgresBackend {
    /// Connects a master pool and, when `READ_REPLICA_ENABLED=true`, the replica pool this
    /// worker reads from. Both pools use the capture's `DB_*` names and defaults.
    pub async fn from_env() -> Result<Self, StorageError> {
        Self::from_lookup(&|name| env::var(name).ok()).await
    }

    /// Connects the master pool from `url`; with no replica configured the reader is the
    /// master pool itself (`src/database/client.ts:97-100`). The harness and the tests use
    /// this.
    pub async fn connect(url: &str) -> Result<Self, StorageError> {
        let options = url.parse::<PgConnectOptions>()?;
        Self::with_pools(utc(options), PoolBounds::default(), None).await
    }

    /// Builds the backend without dialling. The dyn-compatibility test and the migration
    /// target use it, because neither needs a live connection to prove the trait objects.
    pub fn connect_lazy(url: &str) -> Result<Self, StorageError> {
        let options = url.parse::<PgConnectOptions>()?;
        let master = lazy_pool(utc(options), &PoolBounds::default());
        let reader = master.clone();
        Ok(Self {
            master,
            reader,
            settings: None,
        })
    }

    /// Supplies the `nip50`/`nip56` gates. Absent settings mean both features are off,
    /// matching the capture's optional settings getter.
    pub fn with_settings(mut self, settings: Arc<Settings>) -> Self {
        self.settings = Some(settings);
        self
    }

    /// The master pool, for the migrator and for callers that own their own transactions.
    pub fn master(&self) -> &PgPool {
        &self.master
    }

    /// Applies the embedded schema migrations.
    pub async fn migrate(&self) -> Result<(), StorageError> {
        migrate_pool(&self.master).await
    }

    /// Opens a serializable transaction (`src/database/transaction.ts:12`).
    pub fn begin(&self) -> crate::repositories::StorageFuture<'_, PostgresTransaction> {
        Box::pin(async move {
            let transaction = self
                .master
                .begin_with("BEGIN ISOLATION LEVEL SERIALIZABLE")
                .await?;
            Ok(PostgresTransaction {
                transaction: tokio::sync::Mutex::new(Some(transaction)),
            })
        })
    }

    pub(crate) fn gates(&self) -> Gates {
        let Some(settings) = &self.settings else {
            return Gates::default();
        };

        let nip50 = settings.nip50.as_ref().and_then(|nip50| {
            (nip50.enabled == Some(true)).then(|| Nip50Gate {
                language: nip50
                    .language
                    .clone()
                    .unwrap_or_else(|| DEFAULT_TS_CONFIG.to_owned()),
                max_query_length: nip50
                    .max_query_length
                    .unwrap_or(DEFAULT_MAX_SEARCH_QUERY_LENGTH),
            })
        });

        let nip56 = settings
            .nip56
            .as_ref()
            .is_some_and(|nip56| nip56.enabled && nip56.hide_actionable_reports);

        Gates { nip50, nip56 }
    }

    async fn from_lookup<F>(lookup: &F) -> Result<Self, StorageError>
    where
        F: Fn(&str) -> Option<String> + Sync,
    {
        let master = master_options(lookup)?;
        let bounds = pool_bounds(lookup, "");
        let replica = if lookup("READ_REPLICA_ENABLED").as_deref() == Some("true") {
            let index = replica_index(lookup)?;
            Some((
                utc(replica_parts(lookup, index)?.options()),
                pool_bounds(lookup, &format!("RR{index}_")),
            ))
        } else {
            None
        };

        Self::with_pools(utc(master), bounds, replica).await
    }

    /// Opens the master pool and, only when a replica is configured, a second one; otherwise
    /// the reader is the master pool, as `src/database/client.ts:97-100` returns it.
    async fn with_pools(
        master: PgConnectOptions,
        master_bounds: PoolBounds,
        replica: Option<(PgConnectOptions, PoolBounds)>,
    ) -> Result<Self, StorageError> {
        let master_pool = connected_pool(master, &master_bounds).await?;
        let reader_pool = match replica {
            Some((options, bounds)) => connected_pool(options, &bounds).await?,
            None => master_pool.clone(),
        };
        Ok(Self {
            master: master_pool,
            reader: reader_pool,
            settings: None,
        })
    }
}

/// A serializable transaction over the master pool. It implements exactly the three
/// repositories the capture's payments service spans; a streaming trait is deliberately
/// absent, because a stream would hold the connection for its whole life.
pub struct PostgresTransaction {
    transaction: tokio::sync::Mutex<Option<Transaction<'static, Postgres>>>,
}

impl PostgresTransaction {
    /// Commits the transaction; dropping it rolls back.
    pub async fn commit(self) -> Result<(), StorageError> {
        let Some(transaction) = self.transaction.into_inner() else {
            return Err(StorageError::InvalidArgument {
                message: "the transaction is already closed",
            });
        };
        transaction.commit().await?;
        Ok(())
    }
}

/// Applies the embedded migrations to one pool. Running it twice is a no-op.
pub async fn migrate_pool(pool: &PgPool) -> Result<(), StorageError> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}

fn pool_options(bounds: &PoolBounds) -> PgPoolOptions {
    PgPoolOptions::new()
        .min_connections(bounds.min_connections)
        .max_connections(bounds.max_connections)
        .acquire_timeout(Duration::from_millis(bounds.acquire_timeout_ms))
}

/// Every connection is opened with the session time zone pinned to UTC, so a `timestamp`
/// column round-trips deterministically.
fn utc(options: PgConnectOptions) -> PgConnectOptions {
    options.options([("timezone", "UTC")])
}

fn lazy_pool(options: PgConnectOptions, bounds: &PoolBounds) -> PgPool {
    pool_options(bounds).connect_lazy_with(options)
}

/// Opens a pool and waits for its first connection, so an unreachable database is reported
/// at construction rather than at the first query.
async fn connected_pool(
    options: PgConnectOptions,
    bounds: &PoolBounds,
) -> Result<PgPool, StorageError> {
    Ok(pool_options(bounds).connect_with(options).await?)
}

/// The master connection options: `DB_URI` when set, else the capture's `DB_*` parts.
pub(crate) fn master_options<F>(lookup: &F) -> Result<PgConnectOptions, StorageError>
where
    F: Fn(&str) -> Option<String> + Sync,
{
    if let Some(uri) = lookup("DB_URI") {
        return Ok(uri.parse::<PgConnectOptions>()?);
    }

    Ok(master_parts(lookup)?.options())
}

/// The capture's `DB_*` connection parts.
pub(crate) fn master_parts<F>(lookup: &F) -> Result<ConnectParts, StorageError>
where
    F: Fn(&str) -> Option<String> + Sync,
{
    Ok(ConnectParts {
        host: lookup("DB_HOST").unwrap_or_else(|| "localhost".to_owned()),
        port: parse_port(lookup, "DB_PORT")?.unwrap_or(5432),
        username: lookup("DB_USER").unwrap_or_else(|| "postgres".to_owned()),
        password: lookup("DB_PASSWORD"),
        database: lookup("DB_NAME").unwrap_or_else(|| "postgres".to_owned()),
    })
}

/// The read-replica index the capture computes: `WORKER_INDEX % READ_REPLICAS`.
pub(crate) fn replica_index<F>(lookup: &F) -> Result<u32, StorageError>
where
    F: Fn(&str) -> Option<String>,
{
    let worker_index = lookup("WORKER_INDEX")
        .map(|value| value.parse::<u32>())
        .transpose()
        .map_err(|_| StorageError::InvalidArgument {
            message: "WORKER_INDEX must be a non-negative integer",
        })?
        .unwrap_or(0);
    let replicas = lookup("READ_REPLICAS")
        .map(|value| value.parse::<u32>())
        .transpose()
        .map_err(|_| StorageError::InvalidArgument {
            message: "READ_REPLICAS must be a non-negative integer",
        })?
        .unwrap_or(1);

    if replicas == 0 {
        return Err(StorageError::InvalidArgument {
            message: "READ_REPLICAS must be at least 1",
        });
    }

    Ok(worker_index % replicas)
}

/// The `RR{index}_DB_*` parts of one read replica.
pub(crate) fn replica_parts<F>(lookup: &F, index: u32) -> Result<ConnectParts, StorageError>
where
    F: Fn(&str) -> Option<String>,
{
    let prefix = format!("RR{index}_DB_");
    let name = |suffix: &str| lookup(&format!("{prefix}{suffix}"));

    Ok(ConnectParts {
        host: name("HOST").unwrap_or_else(|| "localhost".to_owned()),
        port: parse_port_by(lookup, &format!("{prefix}PORT"))?.unwrap_or(5432),
        username: name("USER").unwrap_or_else(|| "postgres".to_owned()),
        password: name("PASSWORD"),
        database: name("NAME").unwrap_or_else(|| "postgres".to_owned()),
    })
}

/// The pool bounds the capture reads: `DB_MIN_POOL_SIZE`, `DB_MAX_POOL_SIZE` and
/// `DB_ACQUIRE_CONNECTION_TIMEOUT`, or their `RR{n}_` variants.
pub(crate) fn pool_bounds<F>(lookup: &F, prefix: &str) -> PoolBounds
where
    F: Fn(&str) -> Option<String>,
{
    let number =
        |name: &str| lookup(&format!("{prefix}{name}")).and_then(|value| value.parse::<u64>().ok());

    PoolBounds {
        min_connections: number("DB_MIN_POOL_SIZE").unwrap_or(0) as u32,
        max_connections: number("DB_MAX_POOL_SIZE").unwrap_or(3) as u32,
        acquire_timeout_ms: number("DB_ACQUIRE_CONNECTION_TIMEOUT").unwrap_or(60_000),
    }
}

fn parse_port<F>(lookup: &F, name: &str) -> Result<Option<u16>, StorageError>
where
    F: Fn(&str) -> Option<String>,
{
    parse_port_by(lookup, name)
}

fn parse_port_by<F>(lookup: &F, name: &str) -> Result<Option<u16>, StorageError>
where
    F: Fn(&str) -> Option<String>,
{
    lookup(name)
        .map(|value| {
            value
                .parse::<u16>()
                .map_err(|_| StorageError::InvalidArgument {
                    message: "a database port must be a valid TCP port",
                })
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + Sync {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn a_db_uri_wins_over_the_parts() {
        let env = lookup(&[
            ("DB_URI", "postgres://alice:secret@db.internal:6543/relay"),
            ("DB_HOST", "ignored"),
        ]);
        let options = master_options(&env).expect("a parseable uri");
        assert_eq!(options.get_host(), "db.internal");
        assert_eq!(options.get_port(), 6543);
        assert_eq!(options.get_username(), "alice");
        assert_eq!(options.get_database(), Some("relay"));
    }
    #[test]
    fn the_parts_carry_the_capture_defaults() {
        let parts = master_parts(&lookup(&[])).expect("defaults");
        assert_eq!(
            parts,
            ConnectParts {
                host: "localhost".to_owned(),
                port: 5432,
                username: "postgres".to_owned(),
                password: None,
                database: "postgres".to_owned(),
            }
        );
    }

    #[test]
    fn the_parts_are_read_one_by_one() {
        let env = lookup(&[
            ("DB_HOST", "10.0.0.5"),
            ("DB_PORT", "6432"),
            ("DB_USER", "relay"),
            ("DB_PASSWORD", "hunter2"),
            ("DB_NAME", "nostream"),
        ]);
        let parts = master_parts(&env).expect("parts");
        assert_eq!(parts.host, "10.0.0.5");
        assert_eq!(parts.port, 6432);
        assert_eq!(parts.username, "relay");
        assert_eq!(parts.password.as_deref(), Some("hunter2"));
        assert_eq!(parts.database, "nostream");
    }

    #[test]
    fn a_bad_port_is_an_invalid_argument() {
        let error = master_parts(&lookup(&[("DB_PORT", "eighty")])).expect_err("a bad port");
        assert!(matches!(error, StorageError::InvalidArgument { .. }));
    }

    #[test]
    fn the_replica_index_is_the_worker_index_modulo_the_replica_count() {
        assert_eq!(
            replica_index(&lookup(&[("WORKER_INDEX", "5"), ("READ_REPLICAS", "2")])).unwrap(),
            1
        );
        assert_eq!(replica_index(&lookup(&[])).unwrap(), 0);
    }

    #[test]
    fn a_zero_replica_count_is_rejected() {
        let error = replica_index(&lookup(&[("READ_REPLICAS", "0")])).expect_err("zero replicas");
        assert!(matches!(error, StorageError::InvalidArgument { .. }));
    }

    #[test]
    fn the_replica_parts_use_their_own_prefix() {
        let env = lookup(&[
            ("RR1_DB_HOST", "replica.internal"),
            ("RR1_DB_PORT", "7432"),
            ("RR1_DB_USER", "reader"),
            ("RR1_DB_NAME", "nostream"),
        ]);
        let parts = replica_parts(&env, 1).expect("parts");
        assert_eq!(parts.host, "replica.internal");
        assert_eq!(parts.port, 7432);
        assert_eq!(parts.username, "reader");
        assert_eq!(parts.database, "nostream");
    }

    #[test]
    fn the_pool_bounds_carry_the_capture_defaults_and_prefixes() {
        assert_eq!(
            pool_bounds(&lookup(&[]), ""),
            PoolBounds {
                min_connections: 0,
                max_connections: 3,
                acquire_timeout_ms: 60_000,
            }
        );
        assert_eq!(
            pool_bounds(
                &lookup(&[
                    ("RR2_DB_MIN_POOL_SIZE", "1"),
                    ("RR2_DB_MAX_POOL_SIZE", "9"),
                    ("RR2_DB_ACQUIRE_CONNECTION_TIMEOUT", "1500"),
                ]),
                "RR2_"
            ),
            PoolBounds {
                min_connections: 1,
                max_connections: 9,
                acquire_timeout_ms: 1500,
            }
        );
    }

    #[tokio::test]
    async fn absent_settings_leave_both_gates_off() {
        let backend =
            PostgresBackend::connect_lazy("postgres://localhost/postgres").expect("a lazy backend");
        let gates = backend.gates();
        assert!(gates.nip50.is_none());
        assert!(!gates.nip56);
    }

    #[tokio::test]
    async fn settings_supply_the_search_language_and_the_exclusion_gate() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../resources/default-settings.yaml"
        ))
        .expect("the shipped defaults are readable");
        let mut document: serde_yaml::Value =
            serde_yaml::from_str(&raw).expect("the shipped defaults are valid YAML");
        for (path, value) in [
            ("nip50.enabled", serde_yaml::Value::Bool(true)),
            (
                "nip50.language",
                serde_yaml::Value::String("english".to_owned()),
            ),
            ("nip56.enabled", serde_yaml::Value::Bool(true)),
            ("nip56.hideActionableReports", serde_yaml::Value::Bool(true)),
        ] {
            document = nostream_config::path::set_by_path(&document, path, value)
                .expect("the path is writable");
        }
        let settings: Settings = serde_yaml::from_value(document).expect("the defaults fit");
        let backend = PostgresBackend::connect_lazy("postgres://localhost/postgres")
            .expect("a lazy backend")
            .with_settings(Arc::new(settings));
        let gates = backend.gates();
        let nip50 = gates.nip50.expect("nip50 is on");
        assert_eq!(nip50.language, "english");
        assert_eq!(nip50.max_query_length, DEFAULT_MAX_SEARCH_QUERY_LENGTH);
        assert!(gates.nip56);
    }
}
