# ADR 0003: The storage seam and the Postgres backend (job 007)

- **Status:** accepted (job 007, Phase 2 slice 1)
- **Deciders:** the rewrite team, on the evidence in job 007's recon and spec
- **Date:** 2026-10-19

## Context

`nostream-storage` declared nine repository traits with 27 representative methods and a
Postgres backend whose `connect` returned `NotImplemented`. The relay needs all 51
methods the capture's interfaces declare (`src/@types/repositories.ts:40-146`), a
streaming subscription path, a stored-row type that carries the five storage-only
columns, and a real Postgres implementation — because Postgres is the differential
oracle every later backend (LMDB, NIP-50, the migration tool) is judged against.

This ADR records the decisions that shape the rest of the phase. Each heading is
greppable.

## Scope slice — surfaces 1 and 2 plus the harness

The 192 TypeScript repository unit tests assert **SQL text** (83 `.toString()`
assertions), so they cannot be re-expressed against a second backend. The
backend-agnostic oracle is therefore a differential harness: one corpus, one recorded
51-method script, replayed through the Postgres implementation. The LMDB store, NIP-50
on LMDB, `nostream-cli migrate pg-to-lmdb` and the benchmark rig are follow-ups, each
with its own recon and expected cost. This job hands them `EventRecord`, `QueryStream`,
the complete trait set and the fixture as the reference.

## EventRecord — the stored row is not the wire event

`DBEvent` carries `event_deduplication`, `first_seen`, `deleted_at`, `expires_at` and
insert-time `remote_address`, none of which are wire data. Putting them on
`nostream_core::Event` would serialize them into every frame, leak them into
`PartialEq` (two wire-identical events comparing unequal after a retention pass) and
force every core construction site to name them; `#[serde(skip)]` would fix only the
first. `EventRecord` wraps the seven-field event and adds the five columns, so the
canonical hash, `serialize_event`, the filter matcher and `Event::eq` are untouched and
`deny_unknown_fields` still rejects a client-supplied `first_seen`. The wrapper is
`Serialize + Deserialize` because the LMDB backend will store it.

## QueryStream — a borrowing stream, not a channel and not a Vec

`find_by_filters` and `find_reconciliation_items` return
`QueryStream<'a, T>` = `Pin<Box<dyn Stream<Item = Result<T, StorageError>> + Send +
'a>>`, borrowing the store for the stream's life. Postgres holds a portal and a pooled
connection; an LMDB backend will hold a read transaction. A channel would force a
background task and a buffer policy LMDB does not need; a `Vec` would materialise a
10M-row NIP-77 reconciliation.

## sqlx runtime queries — no compile-time macros

Queries use `sqlx::query` with explicit `Row::try_get` conversions, never
`query!`/`query_as!`, and no `.sqlx` cache is committed. CI has no Postgres service for
the macros (they check against a live database at build time), and the event query is
dynamically composed — zero to many filters, each with hex groups, tag `EXISTS` clauses
and optional search — which the macros cannot express. The migrator is embedded with
`sqlx::migrate!("./migrations")`, which needs no database at build time.

## Transactions — serializable, interior-mutable, three repositories

`PostgresBackend::begin()` opens `BEGIN ISOLATION LEVEL SERIALIZABLE`, the port of
`src/database/transaction.ts:12`. `PostgresTransaction` implements exactly
`UserRepository`, `InvoiceRepository` and `NotificationOutboxRepository` — the three the
payments service spans — and not the streaming traits, because a stream would hold the
connection for its whole life. Because sqlx implements `Executor` for
`&mut PgConnection` while the trait methods take `&self`, the transaction holds a
`tokio::sync::Mutex<Option<Transaction>>` and takes the ambient connection per call;
committing consumes it, dropping rolls back. `confirm_invoice` and `admit_user` call
the schema functions, which begin with `ASSERT_SERIALIZED()`; a standalone call opens
its own serializable transaction.

## UNION, not UNION ALL

The capture composes multi-filter queries as `(q1) union (q2) order by …`
(`test/unit/repositories/event-repository.spec.ts:465`), with each branch wrapped so it
keeps its own `ORDER BY`/`LIMIT` and the first filter's order applied to the union.
Recon's "UNION ALL" reading is corrected by that measurement. A mixed search/non-search
filter list fails at the server in both implementations (differing column counts); the
rewrite reproduces the failure rather than papering over it.

## Error propagation — a deliberate divergence

The capture swallows every event-insert error into `0`
(`src/repositories/event-repository.ts:347-372`, `:411-449`). The Rust backend returns
`Ok(0)` only for a conflict the statement itself ignores (`ON CONFLICT DO NOTHING`) and
`Err` for every other database error: a swallowed error is the failure mode the crate's
stub discipline exists to prevent. The parity fixture therefore encodes no
error-swallowing case; the fixture's undo group uses an overflow the server rejects on
both sides.

## Migrations — 37 forward-only files, and three non-transactional knex files

Each knex migration becomes one `.sql` file whose version is the knex timestamp with the
underscore removed (the shared `20230107_230900` becomes `…230900` and `…230901`). There
are no down migrations: two knex migrations are irreversible data migrations and the
rewrite never rolls back. The `event_tags` backfill becomes one set-based `INSERT …
SELECT` producing the same rows as the capture's per-event loop.

The capture has **three** `exports.config = { transaction: false }` files, not two:
`20260420_120000`, `20260427_000000` and `20260926_120000`. sqlx sends a migration file
as a single statement batch, and PostgreSQL refuses `CREATE INDEX CONCURRENTLY` in a
multi-statement batch even outside an explicit transaction. The resolution preserves
the index definitions exactly: the NIP-50 file (one statement) keeps `CONCURRENTLY`
under `-- no-transaction`; the hot-path file keeps `-- no-transaction` but builds its
three indexes without `CONCURRENTLY`; the actionable-report file is transactional with
plain `CREATE INDEX`. The harness compares the whole `public` catalogue against the
knex schema, so a different index definition fails.

## Session time zone — UTC on every connection

Every connection sets `timezone=UTC`, so `timestamp` columns round-trip
deterministically and the capture's server-default assumption holds. The capture's
generator must run with `TZ=UTC` as well: `node-postgres` parses a `timestamp without
time zone` column in the process's local zone, so any other host zone records shifted
`confirmed_at`/`expires_at` values that no correct backend would match.

## The harness's limits

`scripts/storage-parity.sh` is the oracle: the 37 migrations apply from empty and match
the knex catalogue; 110 recorded operations covering all 51 methods replay with an empty
diff; and the unmodified TypeScript relay's 118 Cucumber scenarios run against the
sqlx-migrated database. What it does not judge: the 192 SQL-text unit tests (they are
Postgres-implementation assertions), read-replica *behaviour* (only URL selection is
tested), LMDB, and NIP-50 ranking beyond "same hits, same deterministic order" — the
fixture compares `ts_rank` output from the same server, so a different ranker in a later
backend is a recorded divergence, not a bug. Cucumber stays out of CI: the TS
integration job has no Rust toolchain, so the Rust half
(`tests/migrations.rs`, `tests/parity.rs`) runs there against a `postgres` service and
the script remains the local, complete run.
