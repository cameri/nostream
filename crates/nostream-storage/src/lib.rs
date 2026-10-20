//! `nostream-storage` owns the persistence seam: the nine repository traits, the streaming
//! query surface, the Postgres backend with its embedded migrations, the backend selection,
//! the cache client seam and the LMDB environment.
//!
//! It owns these TypeScript paths from the capture commit
//! (`242a3001d77149e4d70151ec03060c4ef44a1547`):
//!
//! - `src/repositories/` (9 files, ported to `src/postgres/`)
//! - `src/database/client.ts`, `src/database/transaction.ts` (`src/postgres/mod.rs`)
//! - the schema: `migrations/` (37 knex migrations, ported to `migrations/*.sql`)
//! - `src/cache/client.ts`, `src/adapters/redis-adapter.ts`
//! - `src/utils/event-store.ts`, `src/utils/hidden-content-cache.ts`
//! - `src/@types/{adapters,cache,database,repositories,invite-code,invoice,nip05,report,
//!   notification-outbox,user}.ts`
//! - `src/factories/event-repository-factory.ts`
//!
//! What it deliberately does **not** own: the relay handlers that call these traits, the
//! payments service, and the LMDB backend. The Redis cache, `LmdbEnv`'s environment slice
//! and `backend::data_dir` remain labelled stubs; the Postgres backend is complete.

pub mod backend;
pub mod cache;
pub mod error;
pub mod event_store;
#[cfg(feature = "postgres")]
pub mod postgres;
pub mod records;
pub mod repositories;

pub use backend::{Backend, LmdbEnv};
pub use error::StorageError;
#[cfg(feature = "postgres")]
pub use postgres::{PostgresBackend, PostgresTransaction};
