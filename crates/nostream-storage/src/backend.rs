//! Backend selection and the LMDB environment. Mirrors `src/utils/event-store.ts` (the
//! selection half) and the storage boundary in `src/@types/adapters.ts`.

use std::path::{Path, PathBuf};

use nostream_core::EventStoreBackend;

#[cfg(feature = "lmdb")]
use heed::{Env, EnvFlags, EnvOpenOptions};

#[cfg(feature = "lmdb")]
use crate::error::StorageError;
#[cfg(feature = "lmdb")]
use crate::lmdb::{LMDB_MAX_DBS, LMDB_MAX_READERS};

/// The directory one backend's data lives in, under the root a caller supplies.
/// `src/@types/adapters.ts` names the LMDB store as a directory of its own beside the
/// database it replaces.
pub const LMDB_DIR: &str = "lmdb";

/// The file heed keeps an environment's data in, under [`LMDB_DIR`]. The store never changes
/// it: another name would be a different environment to every existing reader of the path.
pub const LMDB_DATA_FILE: &str = "data.mdb";

/// Resolves the data directory under `root` for one backend. A backend that keeps its data
/// somewhere other than a directory of its own answers `None`.
pub fn data_dir(root: &Path, backend: EventStoreBackend) -> Option<PathBuf> {
    match backend {
        EventStoreBackend::Lmdb => Some(root.join(LMDB_DIR)),
        EventStoreBackend::Postgres => None,
    }
}

/// An opened LMDB environment, with the named databases the backend creates.
///
/// The constructor is the crate's single `unsafe` boundary. heed 0.20.5 marks
/// `EnvOpenOptions::open` unsafe because an LMDB environment memory-maps a file shared with
/// other processes and its guarantees collapse if the caller breaks the locking protocol.
/// heed itself upholds the in-process part: it canonicalizes the path, deduplicates through
/// a process-global registry, returns the *same* `Env` for a second open with equal options
/// and `Error::BadOpenOptions` when they differ (heed-0.20.5 `src/env.rs`, `OPENED_ENV`).
/// heed's documented preconditions, and where each stands today:
///
/// - **No long-lived transactions** — upheld by the code: every repository call opens a
///   transaction, uses it, and commits or drops it inside one `spawn_blocking` closure;
///   nothing holds one across an await.
/// - **No aborting the process with an active transaction** — relied on the operator for
///   SIGKILL-class exits; the daemon drain path must ensure a clean shutdown
///   (SIGINT/SIGTERM drain through `ShutdownState` does not abort mid-transaction).
/// - **No network filesystems** — relied on the operator: `open` accepts any path and only
///   `create_dir_all` before mapping; the daemon's backend factory must refuse a remote
///   location before this environment is wired into settings.
/// - **`NO_LOCK` requires self-managed concurrency; a broken lock file means
///   synchronization issues and possible UB** — split responsibility. The code guarantees
///   its half: the only flag it passes is `READ_ONLY`, for the verify opener, so `NO_LOCK`
///   is never in play and LMDB's own locking runs. The lock file belongs to LMDB: this crate
///   never reads, writes or removes it, and a read-only open recreates a missing `lock.mdb`
///   beside `data.mdb`. The operator must supply the rest: the data directory's lock file
///   must not be broken.
/// - **One `map_size` per path for the life of the process** — upheld by heed + propagated:
///   heed's per-process `OPENED_ENV` registry returns the same `Env` for a second open with
///   equal options and `Error::BadOpenOptions` when they differ, and `open` surfaces that
///   error to the caller rather than opening a second environment. `Env::resize` is unsafe
///   as well, so the map is sized once and never grown.
#[cfg(feature = "lmdb")]
#[derive(Debug, Clone)]
pub struct LmdbEnv {
    env: Env,
    path: PathBuf,
}

#[cfg(feature = "lmdb")]
impl LmdbEnv {
    /// Opens (creating if needed) an LMDB environment at `path` with `map_size` bytes, room
    /// for the backend's named databases and its reader slots.
    pub fn open(path: impl Into<PathBuf>, map_size: usize) -> Result<Self, StorageError> {
        let path = path.into();
        std::fs::create_dir_all(&path).map_err(|source| StorageError::CreateDirectory {
            path: path.clone(),
            source,
        })?;
        let env = Self::open_with(&path, map_size, EnvFlags::empty())?;
        Ok(Self { env, path })
    }

    /// Opens an existing LMDB environment at `path` read-only, and creates nothing.
    ///
    /// The directory is not made and the file is not created: a path with no environment is
    /// heed's error rather than a new file. `READ_ONLY` takes no write lock, and this
    /// constructor opens no transaction of its own.
    ///
    /// heed answers `Error::BadOpenOptions` for a second open of one path with different
    /// options, and its registry holds the environment process-wide, so dropping a handle does
    /// not free the path: a caller that already opened this path writable cannot then open it
    /// read-only, or the other way round, and a caller that needs the writable one afterwards
    /// must not open it here first.
    pub fn open_existing(path: impl Into<PathBuf>, map_size: usize) -> Result<Self, StorageError> {
        let path = path.into();
        let env = Self::open_with(&path, map_size, EnvFlags::READ_ONLY)?;
        Ok(Self { env, path })
    }

    /// The one place this crate opens an environment, so the `unsafe` precondition list above
    /// is answered once and `open` and `open_existing` cannot drift apart.
    fn open_with(path: &Path, map_size: usize, flags: EnvFlags) -> Result<Env, StorageError> {
        // # Safety: the preconditions on `LmdbEnv` above, each marked upheld or relied-on:
        // no env flags beyond `READ_ONLY` when the caller passes it (LMDB's locking runs, and
        // the write half of the list is vacuous), transactions never escape the closure they
        // are opened in, and heed's per-process dedup turns a second open into the same Env or
        // BadOpenOptions. The network-filesystem precondition rests on the operator passing a
        // local path; see the list above.
        #[allow(unsafe_code)]
        let env = unsafe {
            EnvOpenOptions::new()
                .map_size(map_size)
                .max_dbs(LMDB_MAX_DBS)
                .max_readers(LMDB_MAX_READERS)
                .flags(flags)
                .open(path)
        }
        .map_err(|source| StorageError::OpenLmdb {
            path: path.to_path_buf(),
            source,
        })?;
        Ok(env)
    }

    /// The environment handle, for the repository implementations.
    pub fn env(&self) -> &Env {
        &self.env
    }

    /// The directory the environment was opened from.
    pub fn path(&self) -> &Path {
        &self.path
    }
}
