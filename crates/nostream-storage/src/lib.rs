//! `nostream-storage` owns the persistence seam: the nine repository traits, the streaming
//! query surface, the Postgres backend with its embedded migrations, the LMDB backend, the
//! backend selection and the LMDB environment.
//!
//! It owns these TypeScript paths from the capture commit
//! (`242a3001d77149e4d70151ec03060c4ef44a1547`):
//!
//! - `src/repositories/` (9 of the 10 files, ported to `src/postgres/` and `src/lmdb/`)
//! - `src/database/client.ts`, `src/database/transaction.ts` (`src/postgres/mod.rs`)
//! - the schema: `migrations/` (37 knex migrations, ported to `migrations/*.sql`)
//! - `src/utils/event-store.ts` (the mirror of `src/utils/hidden-content-cache.ts` is the
//!   relay's: the cache polls the report repository from a settings-dependent task, so
//!   `nostream-relay::hidden_content` owns it and this crate owns only the query it calls)
//! - `src/@types/{database,repositories,invite-code,invoice,nip05,report,
//!   notification-outbox,user}.ts`
//! - `src/factories/event-repository-factory.ts`
//!
//! What it deliberately does **not** own: the relay handlers that call these traits, the
//! payments service, the daemon's backend factory and the `nostream-cli migrate pg-to-lmdb`
//! tool. The cache is not a cache server: no Redis client is added and
//! `src/cache/client.ts` / `src/adapters/redis-adapter.ts` are not ported — the decision and
//! what would overturn it are ADR `0010-services-worker-model-and-cache.md`. Both backends are
//! complete: Postgres against the 37-migration schema, and LMDB against the same column
//! contract for 9 of the capture's 10 repositories — `user_subscriptions` has a TypeScript
//! repository and no trait yet, and `events.first_seen` is stored but never indexed
//! (`docs/rewrite/decisions/0011-lmdb-backend.md`).

pub mod backend;
pub mod error;
pub mod event_store;
#[cfg(feature = "lmdb")]
pub mod lmdb;
#[cfg(feature = "postgres")]
pub mod postgres;
pub mod records;
pub mod repositories;

#[cfg(feature = "lmdb")]
pub use backend::LmdbEnv;
pub use backend::data_dir;
pub use error::StorageError;
#[cfg(feature = "lmdb")]
pub use lmdb::{LmdbBackend, MapUsage};
#[cfg(feature = "postgres")]
pub use postgres::{PostgresBackend, PostgresTransaction};
