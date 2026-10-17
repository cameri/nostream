//! `nostream-storage` owns the persistence seam: the repository traits, the backend selection,
//! the cache client seam and the LMDB environment.
//!
//! It owns these TypeScript paths from the capture commit
//! (`242a3001d77149e4d70151ec03060c4ef44a1547`):
//!
//! - `src/repositories/` (9 files; `src/repositories/event-repository.ts`'s 622-line body is
//!   **not** ported — Phase 2 fills the implementations behind the traits)
//! - `src/database/client.ts`, `src/database/transaction.ts`
//! - `src/cache/client.ts`, `src/adapters/redis-adapter.ts`
//! - `src/utils/event-store.ts`, `src/utils/hidden-content-cache.ts`
//! - `src/@types/{adapters,cache,database,repositories,invite-code,invoice,nip05,report,
//!   notification-outbox,user}.ts`
//! - `src/factories/event-repository-factory.ts`
//!
//! Phase 1 implements exactly one real slice: `backend::lmdb` opens an LMDB environment with
//! `heed` and puts/gets values, retiring the C-toolchain build risk while the crate is empty.
//! The Postgres backend and the Redis cache are labelled stubs — choosing `sqlx` versus
//! `tokio-postgres` versus a pool crate is a Phase 2 decision that would otherwise be made
//! for every repository port at once.

pub mod backend;
pub mod cache;
pub mod error;
pub mod event_store;
pub mod repositories;

pub use backend::{Backend, LmdbEnv};

pub use error::StorageError;
