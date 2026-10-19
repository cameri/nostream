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

Every constructor (`from_env`, `connect`, `connect_lazy`) sets `timezone=UTC`, so
`timestamp` columns round-trip deterministically and the capture's server-default
assumption holds. The capture's generator must run with `TZ=UTC` as well:
`node-postgres` parses a `timestamp without time zone` column in the process's local
zone, so any other host zone records shifted `confirmed_at`/`expires_at` values that no
correct backend would match.

## Read replicas — one pool until a replica is configured

With `READ_REPLICA_ENABLED` unset the reader is the master pool itself (a clone of the
same `PgPool`), exactly as `src/database/client.ts:97-100` returns the write client; a
second pool is opened only when a replica is configured. `users::is_vanished`'s vanish
probe reads through the reader, because the capture's `hasActiveRequestToVanish` has no
client parameter and therefore reads the replica.

## NIP-50 — the text-search configuration is SQL text, not a bind

The capture binds the configuration (`?::regconfig`,
`src/repositories/event-repository.ts:203-206`); a driver bind makes the expression
non-constant, so PostgreSQL cannot match the GIN index built on
`to_tsvector('simple', event_content)` — the capture misses its own index too (measured
by the performance lens: 444.8-671.3 ms per execution through a `text`-typed bind versus
0.088 ms through the index). This port deliberately diverges: `nip50.language` is
validated against `^[a-z_][a-z0-9_]*$` (an invalid value is
`StorageError::InvalidArgument`, never SQL) and inlined as
`to_tsvector('<language>'::regconfig, …)`, the exact indexed expression; the search term
stays a bind. Hits and their order are unchanged (same `ts_rank` over the same predicate);
only the plan changes. `tests/migrations.rs` EXPLAINs the predicate with sequential scans
disabled and fails unless the plan names `events_content_fts_idx`; the unit tests pin the
inlined SQL.

## Batching — the bind limit, and its partial-commit window

`create_many`/`upsert_many` split their input at PostgreSQL's 65 535-bind limit
(7 281 rows at nine binds each, 6 553 at ten — an upsert row's `deleted_at` is the literal
NULL, so it costs no parameter), so up to one batch is the capture's single statement. Above one batch, a mid-batch error returns `Err` after the earlier
batches committed: the rows already written stay written. The capture's single statement
would instead fail wholesale (or, past the same limit, be swallowed into `0` by its
`catch`). Callers that need all-or-nothing semantics for more than one batch must own a
transaction.

## Backend coupling — sqlx behind a feature

The `postgres` feature (default on) owns the `sqlx` dependency, the `postgres` module and
the two driver error variants (`Database`, `Migration`); a build with
`--no-default-features` compiles the trait seam with no Postgres driver linked, which is
what the LMDB follow-up will use. `heed` is not optional yet, because `LmdbEnv` is part of
this crate's Phase-1 slice; the LMDB backend decides whether to keep it when the seam gains
a second implementation.

## The seam's stream is `Send` — heed's `read-txn-no-tls` is required

`QueryStream` is `Send`-bounded, which matches how the relay consumes it. A stream that
owns an LMDB read transaction can only satisfy that bound with heed's `read-txn-no-tls`
feature (heed 0.20.5 `src/txn.rs`: `RoTxn: Send` under that feature), so the workspace
enables it. The feature is not free of behaviour: `EnvOpenOptions::open` ORs
`EnvFlags::NO_TLS` (LMDB's `MDB_NOTLS`) into every environment the crate opens, so reader
slots move to the transaction instead of thread-local storage — that forced flag is what
makes moving a read transaction across threads sound. The LMDB backend inherits it for
every environment it creates and must reason about it in revisit 1: a held read transaction
prevents reuse of pages freed by writers for as long as the stream lives. That is
deliberate for reconciliation (a materialised `Vec` of 10M pairs is worse), and revisit 1
says when to change it.

## The harness's limits

`scripts/storage-parity.sh` is the oracle: the 37 migrations apply from empty and match
the knex catalogue; the fixture's 115 script entries — 111 direct method calls, 2
serializable transaction groups holding 7 nested calls, and two probe calls of one
direct-column op (`user.tos_accepted_at`) — covering all 51 methods replay with an empty
diff; and the unmodified TypeScript relay's 118 Cucumber scenarios run against the
sqlx-migrated database. What it does not judge: the 192 SQL-text unit tests (they are
Postgres-implementation assertions), read-replica *behaviour* (only URL selection is
tested), LMDB, and NIP-50 ranking beyond "same hits, same deterministic order" — the
fixture compares `ts_rank` output from the same server, so a different ranker in a later
backend is a recorded divergence, not a bug. Cucumber stays out of CI: the TS
integration job has no Rust toolchain, so the Rust half
(`tests/migrations.rs`, `tests/parity.rs`) runs there against a `postgres` service and
the script remains the local, complete run.

## Consequences

- The Postgres backend is the reference implementation; every later backend is judged by
  the differential fixture. `EventRecord::row_id` is Postgres's `events.id` and is
  backend-defined: an LMDB store may leave it `None` on read, and the doc says so.
- `events.expires_at` is a PostgreSQL `integer`, so a NIP-40 expiry beyond `i32::MAX`
  (2038-01-19) is `StorageError::ValueOutOfRange` here. An LMDB store would accept it,
  which is a future parity question, not an error to paper over.
- `PostgresBackend::begin()` and `PostgresTransaction` are the only transaction entry
  point. A backend-agnostic caller (the payments service) cannot be written against two
  backends until a trait-level transaction abstraction exists; that is follow-up work.
- The parity projection compares `(event_id, created_at, expires_at,
  deleted_at.is_some(), event_deduplication)` and drops call-generated timestamps. It
  does not compare `remote_address` or `row_id`; a backend that stored a wrong address
  would pass the oracle. If the address becomes part of the row contract, add it to the
  projection (the corpus already carries one).
- `EventRecord` is `Serialize + Deserialize` with no version tag and no `#[serde(default)]`.
  An LMDB store that writes it must decide its encoding version before the first field is
  added, or existing rows stop decoding; that decision belongs to follow-up 3 (trigger 6).
- The harness publishes its ports on `PARITY_BIND` (default `127.0.0.1`) with per-run
  generated Postgres and Redis passwords; no host address or credential is committed.
- 43 new non-database tests (records, env resolution, SQL composition, error mapping) keep
  `cargo test --workspace` meaningful without a database; the two database targets stay
  `#[ignore]`d and run in CI against a `postgres:16-alpine` service.

## Costs inherited from the capture

These queries are the capture's SQL and index set; the performance lens measured them and
they are recorded here so the benchmark follow-up starts from facts, not surprise:

- `count_by_filters` hashes the whole matching id set (267.6 ms for two broad branches at
  200k events, 7 MB spilled); NIP-45 COUNT inherits it.
- A tag `EXISTS` with many values gathers every matching event before the `LIMIT` (44.9 ms
  for 200 `#p` values); a covering `(tag_name, tag_value, event_id)` index would help, but
  the schema is pinned to the capture.
- A kind-only limited REQ walks the `created_at` index and filters (5 508 rows discarded to
  return 500); there is no `(event_kind, created_at DESC, event_id)` index in the capture.
- `claim_batch`'s `pending OR processing` predicate cannot use
  `idx_notification_outbox_dispatch` (12.2 ms and a scan at 20k outbox rows).
- Hex prefix criteria use `substring(...)`, which is not sargable.

None of these is introduced here, and changing any would diverge from the capture's
schema or SQL; the hunt for them belongs to the benchmark rig (follow-up 6).

## Revisit triggers

1. **A long-lived LMDB read transaction hurts writes.** If the benchmark follow-up measures
   write stalls caused by an open `find_reconciliation_items` stream, change the seam to a
   bounded stream (or batched reads) and re-record the `QueryStream` decision; the `Send`
   bound and heed's feature stay.
2. **A second backend needs a transaction abstraction.** The first caller that must run
   against both backends inside one transaction reopens the transaction-shape decision:
   either a trait-level transaction or a backend-specific payments service.
3. **A NIP-40 expiry past 2038 becomes reachable.** If a client can publish one, the
   `events.expires_at integer` limit reopens: either widen the column (knex-identical? no —
   the schema is the capture's) or clamp and record the divergence in the fixture.
4. **The NIP-50 language changes at runtime.** The index is built with `simple`. The
   migrations target EXPLAINs the *composer's* statement at the fixture's settings, so a
   composer or schema change that stops matching the index fails that target. A deployment
   that runs a different `nip50.language` is covered by the same guard through
   `PARITY_NIP50_LANGUAGE`: `PARITY_NIP50_LANGUAGE=english cargo test -p nostream-storage
   --test migrations -- --ignored` composes at that language and fails unless the index was
   rebuilt with it. The switch is in `tests/common/mod.rs::settings_from_fixture`; editing
   the fixture's override is the equivalent path.
5. **The capture's own FTS miss is fixed upstream.** If the TypeScript starts inlining the
   configuration, the divergence above disappears; the fixture's compared values do not
   change (its `subject` block is regenerated, so the file itself does).
6. **The LMDB row encoding gains a field.** Before `EventRecord` is persisted by a second
   backend, version the encoding (a header tag or `#[serde(default)]` on new fields), or
   decoding an existing store breaks on the first schema change.
