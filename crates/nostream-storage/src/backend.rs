//! Backend selection and the two backends. Mirrors `src/utils/event-store.ts` (the selection
//! half) and the storage boundary in `src/@types/adapters.ts`.

use std::path::{Path, PathBuf};

use heed::types::Str;

use crate::error::StorageError;
use heed::{Database, Env, EnvOpenOptions};

/// The storage backends the rewrite can be configured with (`src/constants/base.ts`
/// `EventStoreBackend`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Backend {
    Postgres,
    Lmdb,
}

impl Backend {
    /// The settings spelling of this backend.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Postgres => "postgres",
            Self::Lmdb => "lmdb",
        }
    }

    /// Parses a settings value.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "postgres" => Some(Self::Postgres),
            "lmdb" => Some(Self::Lmdb),
            _ => None,
        }
    }
}

impl std::fmt::Display for Backend {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// An opened LMDB environment with one named database of string keys and values.
///
/// The constructor is the crate's single `unsafe` boundary. heed 0.20.5 marks
/// `EnvOpenOptions::open` unsafe because an LMDB environment memory-maps a file shared with
/// other processes and its guarantees collapse if the caller breaks the locking protocol.
/// heed itself upholds the in-process part: it canonicalizes the path, deduplicates through
/// a process-global registry, returns the *same* `Env` for a second open with equal options
/// and `Error::BadOpenOptions` when they differ (heed-0.20.5 `src/env.rs`, `OPENED_ENV`).
/// What this crate must therefore uphold — heed's documented preconditions, unchanged here:
///
/// - never open an environment with `NO_LOCK` (concurrent access becomes the caller's job),
///   `NO_SYNC` or `NO_META_SYNC` (durability is silently dropped) — none is used;
/// - never point an environment at a network filesystem — the lock file semantics do not
///   survive it; the Phase-2 backend factory must refuse one;
/// - keep one `map_size` per path for the life of the process — a second open with a
///   different size surfaces as `Error::BadOpenOptions`, which `open` propagates.
#[derive(Debug, Clone)]
pub struct LmdbEnv {
    env: Env,
    path: PathBuf,
}

/// Phase 1 stub — job 005; connects to Postgres with the Phase-2 driver choice; see `src/database/client.ts`.
#[derive(Debug, Clone, Default)]
pub struct PostgresBackend;

impl PostgresBackend {
    /// Connects to the database named by `DATABASE_URI` (or the `DB_*` parts).
    ///
    /// Phase 1 stub — job 005; will connect a pool through the Phase-2 driver; see `src/database/client.ts`.
    pub async fn connect(_database_uri: &str) -> Result<Self, StorageError> {
        Err(StorageError::NotImplemented {
            module: "storage::backend::postgres::connect",
        })
    }
}

impl LmdbEnv {
    /// Opens (creating if needed) an LMDB environment at `path` with `map_size` bytes.
    pub fn open(path: impl Into<PathBuf>, map_size: usize) -> Result<Self, StorageError> {
        let path = path.into();
        std::fs::create_dir_all(&path).map_err(|source| StorageError::CreateDirectory {
            path: path.clone(),
            source,
        })?;

        // # Safety: upheld by the preconditions on `LmdbEnv` above — no NO_LOCK/NO_SYNC
        // flags, a local (non-network) path, and heed's own per-process dedup making a
        // second open with the same options return the same environment rather than a
        // second one. See heed-0.20.5's documented safety contract (`src/env.rs`).
        #[allow(unsafe_code)]
        let env =
            unsafe { EnvOpenOptions::new().map_size(map_size).open(&path) }.map_err(|source| {
                StorageError::OpenLmdb {
                    path: path.clone(),
                    source,
                }
            })?;
        Ok(Self { env, path })
    }

    /// Writes one value under one key, committing immediately.
    pub fn put(&self, key: &str, value: &str) -> Result<(), StorageError> {
        let mut transaction = self.env.write_txn()?;
        let database: Database<Str, Str> = self.env.create_database(&mut transaction, None)?;
        database.put(&mut transaction, key, value)?;
        transaction.commit()?;
        Ok(())
    }

    /// Reads one value; `Ok(None)` means the key is absent.
    pub fn get(&self, key: &str) -> Result<Option<String>, StorageError> {
        let transaction = self.env.read_txn()?;
        let Some(database) = self.env.open_database::<Str, Str>(&transaction, None)? else {
            return Ok(None);
        };
        Ok(database.get(&transaction, key)?.map(str::to_owned))
    }

    /// The environment handle, for the Phase-2 repository implementations.
    pub fn env(&self) -> &Env {
        &self.env
    }

    /// The directory the environment was opened from.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Resolves the database path under `root` for one backend.
///
/// Phase 1 stub — job 005; will pick the per-backend data directory; see `src/@types/adapters.ts`.
pub fn data_dir(root: &Path, backend: Backend) -> Result<PathBuf, StorageError> {
    let _ = (root, backend);
    Err(StorageError::NotImplemented {
        module: "storage::backend::data_dir",
    })
}
