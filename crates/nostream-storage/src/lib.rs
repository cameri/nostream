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
//! payments service, the daemon's backend factory and the tool behind
//! `nostream-cli migrate pg-to-lmdb`. It owns that tool's seam — [`migration`], the paged source
//! read and the exact-per-row target write — which exists for that one caller and for no other;
//! the copy, its manifest and its verification live in the CLI. The cache is not a cache server:
//! no Redis client is added and `src/cache/client.ts` / `src/adapters/redis-adapter.ts` are not
//! ported — the decision and what would overturn it are ADR
//! `0010-services-worker-model-and-cache.md`. Both backends are complete: Postgres against the
//! 37-migration schema, and LMDB against the same column contract for 9 of the capture's 10
//! repositories — `user_subscriptions` has a TypeScript repository and no trait yet, and is the
//! one of those ten the migration does not move (`event_tags` is not moved either: it is the
//! trigger-maintained index whose LMDB `tags` database the event write path keeps), and
//! `events.first_seen` is stored but never indexed
//! (`docs/rewrite/decisions/0011-lmdb-backend.md`,
//! `docs/rewrite/decisions/0012-pg-to-lmdb-migration.md`).

pub mod backend;
pub mod error;
pub mod event_store;
#[cfg(feature = "lmdb")]
pub mod lmdb;
pub mod migration;
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

/// The largest page the relay assumes any shipped backend can return for one filter, whatever
/// `limit` it carries.
///
/// A caller that must know whether a page was truncated compares the rows a stream yielded
/// against `min(limit, MAX_PAGE_ROWS)`: a stream that yields that many has a page whose end the
/// relay cannot see, and must say nothing about what lies beyond it.
///
/// This is only the relay's **default** assumption. The obligation itself is stated on
/// [`EventRepository::find_by_filters`](repositories::EventRepository::find_by_filters), in both
/// directions — a backend must yield up to the bound and must not exceed it — and a backend that
/// clamps lower declares its own through
/// [`EventRepository::page_bound`](repositories::EventRepository::page_bound), which the relay
/// reads instead of this constant.
///
/// The two backends reach the bound differently. LMDB clamps every filter to it in code
/// (`lmdb::MAX_PAGE_KEYS`, which is this constant, and the clamp's own test fails if the two
/// drift apart). Postgres does **not** clamp by constant: it honours the filter's own `limit`,
/// with `DEFAULT_FILTER_LIMIT = 500` when there is none. The bound reaches it through the wire
/// instead — `limits.client.subscription.maxLimit` ships at this number and a `REQ` above it is
/// refused (`subscribe.rs:525`) — so the two agree only while that setting does. Raising it
/// above this constant leaves Postgres able to serve more than the relay will believe, which
/// suppresses `finish` where it could have been proved and never claims it where it should not.
pub const MAX_PAGE_ROWS: u64 = 5_000;
