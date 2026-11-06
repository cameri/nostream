# ADR 0010: The LMDB event store behind the existing seam (job 024)

- **Status:** accepted (job 024, Phase 2)
- **Deciders:** the rewrite team, on the evidence in job 024's recon and spec
- **Date:** 2026-11-06

## Context

`nostream-storage` shipped one backend. `src/backend.rs` selected between `postgres` and
`lmdb` and then answered `Phase 1 stub` from `data_dir`, so the second backend the rewrite
exists to provide had a name, a settings value and no code. This job adds it: the event
store, the metadata tail, and the nine repository traits implemented over heed 0.20.5,
with the same integration test the Postgres backend passes replayed against it.

`spec.md` records ten decisions (D1–D10) with their reasons and their measurements. This
document keeps the parts a later reader needs to judge the code: where the state lives, how
a value is shaped, what the seam does not offer, and what the oracle therefore measures.

## The backend is a feature of the crate, not a crate

`lmdb = ["dep:heed", "dep:uuid"]`, default on beside `postgres` (D1). heed was already a
hard dependency, the seams' own ADR says the `--no-default-features` build is what this
follow-up uses (ADR 0003, "Backend coupling"), and a second crate would repeat five
manifest fields plus `[lints] workspace = true` to isolate code that shares every type in
`nostream-storage`. The cost is that `--no-default-features` now links no driver at all —
which is also the point: `cargo check -p nostream-storage --no-default-features --all-targets`
must compile, and it does.

`nostream_storage::Backend` is deleted (D8) and everything uses
`nostream_core::EventStoreBackend`. Two enums with identical variants and spellings were a
drift waiting to happen, and neither had a consumer: `data_dir` now returns
`Option<PathBuf>` — `Some(root/lmdb)` for LMDB, `None` for Postgres — and the LMDB backend
opens `<root>/lmdb` itself.

## Metadata lives in LMDB databases of its own

The eight tail tables are 22 named databases in the same environment (D2): one primary
database per table keyed by its primary key, plus one per query path (`invoices_pending`,
`nip05_by_last_checked_at`, `invite_codes_by_created_at`/`_by_expires_at`,
`dvm_jobs_by_status_created_at`, four `reports_*`, three `outbox_*`/`delivery_log_*`), and a
`meta` database for the report sequence.

**The reason is one write transaction spanning events and tail.** NIP-56's hidden-content
predicate is a `NOT EXISTS` over `reports` inside the events query
(`crates/nostream-storage/src/postgres/sql.rs:291-297`). One environment makes that two
point lookups — `reports_actionable_event` by event id and `reports_actionable_pubkey` by
author — inside the same read transaction that already holds the event row, instead of a
second store read per candidate. An embedded SQL store would have needed a second
dependency and could still tear against the LMDB file.

The price is recorded with the decision: 29 named databases maintained by hand, `DISTINCT`
and `OFFSET` become cursor walks (`BTreeSet` for `find_actionable_targets`, a skip count for
`find_pending_invoices`), and the columns' `CHECK` and foreign-key constraints move into
Rust (§ Constraints, below).

Rows are versioned: one format byte (`ROW_FORMAT_VERSION = 1`), then `serde_json`, the byte
per database rather than per table. ADR 0003 trigger 6 asked for a version marker before a
second backend persisted `EventRecord`, and this is it.

## An event value is a 54-byte header, then JSON

`events` holds `1 + 54` bytes of header, then `serde_json` of `EventRecord` (D5):

|bytes|field|
|---|---|
|1|format version (`1`)|
|8|`created_at`, big-endian i64|
|4|`kind`, big-endian i32|
|8|`expires_at`, big-endian i64, `i64::MIN` for NULL|
|32|author pubkey|
|1|reserved, zero|

The live predicate and the NIP-56 lookup read that header without decoding the body, so
`count_by_filters` and reconciliation copy 55 bytes per candidate instead of an event.
The reserved byte keeps the header at the 54 bytes R7, V35 and AC8 pin, and it is where a
future flag goes without a version bump.

`row_id` stays `None` (D5): it is the Postgres row's `uuid` and nothing reads it through
this backend. Text components of a composite key are NUL-terminated except the final one
(`text_part`), so `tag_key` is `name NUL value NUL created_at ‖ event_id`, and a tag name or
value carrying `0x00` is refused as `InvalidRow` rather than splitting the key.

Soft delete is a flag **and** the row's value, never an index removal (D4): `find_by_filters`
does not apply the live predicate (`sql.rs:119-140` against `:262-267`), so the row must stay
in every read index while `count_by_filters` and reconciliation exclude it. The
`events_deleted` database is the retention scan's path, not the query's.

## The seam has no transaction type (D3)

`RwTxn` borrows the `Env` (heed 0.20.5 `src/txn.rs:119-122`) and a `spawn_blocking` closure
must be `'static`, so a seam-level transaction would need a leaked `&'static Env` plus a
mutex, and would then hold LMDB's **single** writer across every `await` between `begin()`
and `commit()`. That is a worse failure mode than the one it fixes: one stuck caller stops
every write in the process.

What replaces it: a repository method is one whole write transaction, so every write the
seam performs is atomic across every database it touches. What it leaves **unmeasured** is
atomicity *across repository calls* — a caller that needs two writes to succeed or fail
together has no form for it here. `PostgresTransaction` and `begin()` are untouched.

This resolves nothing about ADR 0003 trigger 2 (a second backend needs a transaction
abstraction) except the shape a future one must take: a held LMDB transaction cannot satisfy
it, so the abstraction has to be closure-shaped — `with_write_txn(|tx| …)` — with the
single writer never held across an `await`. The trigger stays open.

## Blocking and streams (D7)

Every heed call — `write_txn`, `read_txn`, `create_database`, iteration and `commit` — runs
inside `tokio::task::spawn_blocking`, because `Env::write_txn` blocks the calling thread on
the writer's mutex and a read transaction must not be held across an `await`. `LmdbBackend`
therefore has two helpers, `write` and `read`, that own their transaction and commit or drop
it inside the closure; no `RwTxn` or `RoTxn` leaves one.

A stream is a key page, not a held transaction. `find_by_filters` collects its union page
inside one blocking closure; the returned `QueryStream` yields values in batches of
`STREAM_BATCH_ITEMS = 256`, each poll opening a read transaction, seeking to the saved
cursor key, copying up to 256 values and dropping it. `find_reconciliation_items` runs the
same loop over keys and never reads a value. **A stream is therefore not a snapshot** (D7):
a row written or deleted between two batches may appear or vanish, where Postgres' portal
holds one snapshot. No comparable behaviour exists to compare, so the divergence is recorded
for the benchmark job, and ADR 0003 trigger 1 ("a long-lived LMDB read transaction hurts
writes") is answered by construction: no transaction outlives a poll, and a dropped stream
pins no pages.

`Env::resize` is `unsafe` and this crate has one audited `unsafe` call, so the map is
preallocated at `LMDB_MAP_SIZE = 64 GiB` and never grown (D6). The same single
`#[allow(unsafe_code)]` open sets `LMDB_MAX_DBS = 64` (the 29 named databases, comfortably
inside) and `LMDB_MAX_READERS = 512`.

## Constraints move into Rust

The store has no server to enforce the columns' `CHECK` and foreign-key constraints, so the
two a caller can violate are enforced on write (R17): a negative
`CreateInviteCodeOptions::remaining_uses` is `InvalidArgument`, and a delivery-log entry
naming an unknown outbox row is `InvalidArgument` while deleting an outbox row walks
`delivery_log_by_outbox` and sets `outbox_id` to NULL. The `status`, `unit`, `report_type`
and `target_type` spellings need no code: they are typed enums parsed by `column_enum!`, so
an invalid spelling cannot reach the writer.

Every `DateTime<Utc>` is truncated to microseconds before encoding, because every column it
lands in is a PostgreSQL `timestamp`; a call takes one `Utc::now()` and uses it for every row
it writes, standing in for the statements' `CURRENT_TIMESTAMP`.

`admit_user` and `confirm_invoice` are Rust in one write transaction each, following the
schema functions they replace. `confirm_invoice` scales by `sats × 1000`, `msats × 1`,
`btc × 100_000_000 × 1000` with checked arithmetic, and answers `ValueOutOfRange` where the
`int8` would overflow. `reports.id` is allocated from `meta` starting at 1; every other
generated id is a UUID v4 in canonical text form, which is why `uuid` (v4) is the job's only
new dependency.

## Oracle: two arms, one executor

The fixture is the capture's recording and both backends are compared against the same
`result.compare` (D10). The 51 method arms moved out of `tests/parity.rs` into
`tests/common/`, where the executor takes a `Repos<'a>` of nine `&dyn` repository
references, so one script drives both backends; what stays Postgres-only is what only
Postgres can reach: raw SQL on `users.tos_accepted_at` and the serializable `transaction`
groups.

`tests/parity_lmdb.rs` opens a store on a `tempfile::TempDir`, inserts the fixture's
483-event corpus and replays **113 of 118** entries. The five it does not replay:

|index|op|why the seam cannot run it|
|---|---|---|
|21|`events.find_by_filters` with `search`|NIP-50 is out of scope; the backend answers `NotImplemented`|
|48, 50|`user.tos_accepted_at`|raw SQL against `backend.master()`, no seam form|
|112, 115|`transaction`|the capture **rolled these back**; reproducing a rollback needs a transaction type this job deliberately does not add|

The other two `transaction` groups, 111 and 117, **committed** in the capture and are
replayed: running their nested ops in order through the seam leaves exactly the state the
commit left, and their comparison — the aggregate `{failed: false, results: [...]}` — is what
those calls return. That is also the evidence for the count rather than a preference: entry
116, `outbox.claim_batch`, expects the outbox row that group 111 committed, so excluding 111
cannot pass. What the transaction decision leaves unmeasured is rollback: the arm proves the
committed groups' effects, not that two calls can fail together.

The target asserts every exclusion against the fixture — an entry is excluded exactly when
its op is one of the five above — so the list cannot grow without the diff showing it.

## Consequences

- One environment, one write transaction, one error taxonomy; no second dependency, and no
  tear between two files.
- 29 named databases and their key encodings are maintained by hand; `DISTINCT`/`OFFSET`
  became cursor walks; two `CHECK`/foreign-key constraints became Rust code.
- Postgres remains the reference: every query path is written against `sql.rs`'s predicates
  and orderings, and the shared executor is what proves it.
- Retention's batch composition can differ from Postgres' planner-chosen order when more than
  1000 rows qualify; both return 1000 rows classified by the same precedence (D13 in
  `spec.md`, Assumption 10). The corpus is 483 events, so no current entry reaches it.
- Two JSON values PostgreSQL's `jsonb` considers equal but that serialize differently
  (`1` against `1.0`) would be distinct deduplication pointers here; the repository builds
  the value in one shape and the relay passes a single string, so today's callers cannot
  reach it (Assumption 11).
