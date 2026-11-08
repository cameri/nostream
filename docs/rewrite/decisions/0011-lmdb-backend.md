# ADR 0011: The LMDB event store behind the existing seam (job 024)

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
a value is shaped, what the seam does not offer, which schema it implements, and what the oracle
therefore measures.

## The backend is a feature of the crate, not a crate

`lmdb = ["dep:heed", "dep:uuid", "dep:tracing"]`, default on beside `postgres` (D1). heed was
already a hard dependency, the seams' own ADR says the `--no-default-features` build is what
this follow-up uses (ADR 0003, "Backend coupling"), and a second crate would repeat five
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
`dvm_jobs_by_status_created_at`, four `reports_*`, four `outbox_*`/`delivery_log_*`), and a
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
Rust (§ Constraints move into Rust, below).

Rows are versioned: one format byte (`ROW_FORMAT_VERSION = 1`), then `serde_json`, the byte
per database rather than per table. ADR 0003 trigger 6 asked for a version marker before a
second backend persisted `EventRecord`, and this is it.

## An event value is a 55-byte header, then JSON

`events` holds `1 + 54 = 55` bytes of header, then `serde_json` of `EventRecord` (D5):

|bytes|field|
|---|---|
|1|format version (`1`)|
|1|flags: bit 0 is `deleted_at.is_some()`, the soft-delete bit (`FLAG_DELETED`)|
|8|`created_at`, big-endian i64|
|4|`kind`, big-endian i32|
|8|`expires_at`, big-endian i64, `i64::MIN` for NULL|
|32|author pubkey|
|1|reserved, zero|

The live predicate and the NIP-56 lookup read that header without decoding the body, so
`count_by_filters` and reconciliation copy 55 bytes per candidate instead of an event.
The flags byte is header byte 0 — the first byte after the format byte — and it already
carries the soft-delete bit, so a second flag lands there behind `FLAG_DELETED` rather than
in the reserved byte. The reserved byte is the header's last (byte 53 of the 54-byte header),
kept so the header stays the length R7, V35 and AC8 pin; a flag that needs its own bit goes
in the flags byte, and the reserved byte is there for a field that has to be a byte wide.

`row_id` stays `None` (D5): it is the Postgres row's `uuid` and nothing reads it through
this backend. Text components of a composite key are NUL-terminated except the final one
(`text_part`), so `tag_key` is `name NUL value NUL created_at ‖ event_id`. A value carrying
`0x00` is refused as `InvalidRow` by `refuse_nul` rather than splitting the key, and
PostgreSQL's `text` cannot hold that byte either, so both backends reject the same value. A
row's own text column meets the same check: the outbox key stopped carrying the target, so
`append` refuses `notification_delivery_log.target_id` through `refuse_nul` rather than
writing a value the capture could not have stored. The three component codecs a key reader
needs — `text_part`, `text_from` and `stamp_key` — have one home, `lmdb/encoding.rs`, beside
the key builders; the tail modules call them rather than keeping copies whose rules could
drift apart.

LMDB bounds a key at 511 bytes (`MDB_MAXKEYSIZE`, which this environment does not raise), and
a `tags` key carries the tag value verbatim. **That is the one place this backend refuses a
row Postgres would keep**: a tag value of 469 bytes or more (with a one-byte tag name) pushes
the key past the bound, so the event's write fails and the relay refuses the event, where the
capture stores it. It is a recorded divergence, not a silent one — the write returns
`StorageError::Lmdb` — and it is not fixed here: the repairs (hashing the value into the key and
looking the row up twice, or a larger `max_key_size` at the open) change the index the benchmark
job will measure. On the read side a criterion too long to name a stored key selects nothing,
rather than failing the whole request.

The `replaceable` pointer is the second variable-length key, and it adds no second divergence.
Its components are length-prefixed — `pubkey ‖ kind ‖ (tag ‖ len ‖ bytes)*`, a string element
written as its own bytes and any other JSON value as its `serde_json` text behind a different
tag — so JSON escaping cannot inflate a value into a refusal: a 235-byte quote-only `d` value
is 235 key bytes, not 474. The same value costs 39 + len bytes here and 43 + len in the `tags`
key, so the tag index refuses first (469 bytes against the pointer's 473), and a value past
the pointer's own bound is refused as `InvalidRow` naming `event_deduplication` before LMDB
sees the key. PostgreSQL keeps either row; when such a value has to be stored, the same repair
the tag bound needs applies.

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

A stream is a key page, not a held transaction, and the two query methods keep different
things — which is what a caller planning memory needs to know:

- `find_by_filters` collects its union page inside one blocking closure, so the stream **holds
  the page**: at most each filter's limit, clamped to `MAX_PAGE_KEYS = 5 000` ids. Each poll
  opens a read transaction, copies up to `STREAM_BATCH_ITEMS = 256` values from that page and
  drops it; nothing more is read from the index, and the page is the only thing resident.
- `find_reconciliation_items` **holds a cursor key**. Each poll opens a read transaction,
  resumes exclusively after the last key the previous batch evaluated, and drops it. A batch
  ends at `STREAM_BATCH_ITEMS` items or `STREAM_BATCH_KEYS = 256` evaluated keys, whichever
  comes first, so a filter that matches few of the keys it walks cannot make one poll span a
  whole range — the cursor resumes exactly where the key cap stopped.
  It scans the filter's own index when that index narrows the filter to a single range that
  runs in `created_at` order (`{authors: [a], kinds: [k]}`, or one exact tag value). An `ids`
  filter whose criteria are all exact ids is read from its own ranges as one batch and sorted,
  because that list is the request's own bound and an `events` key runs in id order; a prefix
  criterion is a byte range over the id field (requirement 12), where `""` is the whole
  database, so it is not the request's list and takes the bounded scan below. Any other filter
  scans `events_by_created_at`, because only that range's order is the oldest-first order the
  seam promises. Reading a candidate costs its header, plus its decoded record only for the tag
  families the key has not already answered.

**A stream is therefore not a snapshot** (D7): a row written or deleted between two batches
may appear or vanish, where Postgres' portal holds one snapshot. No comparable behaviour
exists to compare, so the divergence is recorded for the benchmark job, and ADR 0003 trigger
1 ("a long-lived LMDB read transaction hurts writes") is answered by construction: no
transaction outlives a poll, and a dropped stream pins no pages.

`Env::resize` is `unsafe` and this crate has one audited `unsafe` call, so the map is
preallocated at `LMDB_MAP_SIZE = 64 GiB` and never grown (D6). The same single
`#[allow(unsafe_code)]` open sets `LMDB_MAX_DBS = 64` (the 29 named databases, comfortably
inside) and `LMDB_MAX_READERS = 512`.

Because the map never grows, its approach has to be visible before the first failed write:
`LmdbBackend::open` logs the map size, the bytes the pages in use occupy
(`Env::non_free_pages_size`) and that as a percentage, and `LmdbBackend::map_usage` reports the
same numbers to an operator's tooling.

## What a read holds, and which index it reads

The resident set of a read is the page, never the range it was chosen from, and the size of
that page is the backend's to bound: the effective limit is the filter's own or the capture's
default of 500, clamped to `MAX_PAGE_KEYS = 5 000` — the shipped
`limits.client.subscription.maxLimit` — so a wire `limit` cannot choose an allocation, whether
or not a deployment sets `maxLimit`. A filter's branch holds at most that many rows — the page
itself, kept as a heap rooted at the row it would drop first, so an offer is one comparison
against that root and the page is sorted once, when it is returned — and that page is one
accumulator across every range the plan seeks: the top `limit` is global to them. A range whose
key order *is* the page's order stops at the page's own worst kept row — the heap's root, not
the first row the range happened to offer — keeping every row at that timestamp so a tie breaks
as the capture's does.

One read keeps a second thing resident, and it is a count's rather than a page's: a `tags` count
whose criteria can select one row twice holds an id per row its matcher accepts, and that set is
bounded by `MAX_PAGE_KEYS` — the same 5 000. Below the cap the walk reads no body; at the cap it
stops inserting and decides each further key with a bounded-memory check instead: a repeated key
reads the row's body and asks whether an earlier key of the walk already answered for it, an
earlier criterion that matches one of its tags or, within one `#g` prefix range, a smaller value
the prefix matches. The total is therefore the same at every corpus size, and the set is a
constant 270 352 B once full (measured live: 5 000 ids at a `HashSet` capacity of 7 168 slots,
against 1 081 360 B for the same 20 000-row corpus with the set unbounded). The price of the
cap is a body decode per repeated key past it; an index order that visits each row once is what
would remove that too.

The index is chosen from the filter, and which ranges can stop early follows from the key:

| filter | index | stops when full |
|---|---|---|
| `ids` | `events`, a point or prefix range per criterion | never: the key is the id, so the range runs in id order |
| `authors` + `kinds` | `events_by_author`, one range per whole-pubkey criterion and kind, and one whole-tail range per prefix criterion | when every criterion is a whole pubkey, so a range is one `pubkey ‖ kind ‖ created_at` run; a prefix range spans every kind |
| `authors` alone | `events_by_created_at` | yes — see below |
| a `#` + letter criterion | `tags`, one range per criterion | for an exact value; a `#g` prefix spans values, so its range runs whole |
| anything else | `events_by_created_at` | yes |

Every hex criterion's bounds are widened to the field they name — 32 bytes for an id or a
pubkey — before anything the key carries after it is appended. A prefix is therefore compared
against its own field's bytes and never against the kind, the timestamp or the id that follow,
whether the path is `events` or `events_by_author`. That is why an author prefix with `kinds`
seeks no kind at byte 32: its upper bound runs to the end of the pubkey field, a kind appended
after that bound is compared where no key writes one, and every kind's range would then contain
every other kind's keys — a count visiting each row once per kind. `author_kind_ranges`
(`events.rs`) is where the split is composed, a whole pubkey to one range per kind and a prefix
to one range over its whole tail, and it bounds the composition too: a whole-pubkey × kind
product past `MAX_PAGE_KEYS` composes no range at all and the filter is answered from
`events_by_created_at` instead. `hex_ranges` (`encoding.rs`) is the one place the widening rule
lives. A criterion another already covers, and a repeated kind, seek one range, so a count that
walks ranges whole visits those keys once.

The `authors`-alone row is the capture's own shape rather than the faster index: the author
index orders by kind before `created_at`, so a page ordered by time cannot stop inside it, and
the same query in Postgres walks the created-at index and filters (ADR 0003 records 5 508 rows
discarded to return 500 for the kind-only form). The cost is that a quiet author's page reads
further into the created-at index than the author's own timeline would; the page still stops at
its limit, and the choice belongs to the benchmark job once it can choose with statistics
rather than a rule.

Two consequences of the same bound:

- `count_by_filters` has no page, so it materialises no result set: each filter counts the rows
  it visits and skips one the count already holds — an earlier filter's page when that filter
  had a limit, or a predicate match when it had none — which is the capture's `UNION`. An
  unlimited filter walks its ranges whole, which is what counting every match costs, and a
  `tags` walk that can select one row twice also holds that row's id, up to `MAX_PAGE_KEYS`
  ids (see above). The slot is filled before the cross-filter check, so the set also holds rows
  an earlier filter already counts; the same cap bounds that residue.
- A `tags` range is built from the family's own criteria, so a key inside it has already proved
  that family: the event's body is decoded only for the filter's *other* tag families, and a
  filter with one family decodes none. The id a key ends with answers the rest of the walk, so a
  row two criteria — or two values of a `#g` prefix — both select is counted at the first key
  the walk reaches and skipped at the rest without a body decode, while the set has room: the
  ranges run in the criteria's order, so that key is not necessarily the row's smallest matching
  one. Once the set is full the walk reads the body of a repeated key instead and asks whether
  an earlier key of the walk already answered for it — an earlier criterion, or a smaller value
  of the same prefix — so the count stays exact and its resident set stays a constant. Only those
  two shapes hold the set, whose population is one id per row its matcher accepts: a single exact
  criterion names one key per row. The tags index has no order that visits each row once, which
  is why the cap trades a slot past it for a body decode.

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

## The schema contract is 37 migrations (D9)

The store implements the contract both schema oracles pin: 37 migrations
(`crates/nostream-storage/migrations/`, the count `crates/nostream-storage/tests/migrations.rs:25`
asserts as `EXPECTED_MIGRATIONS`) and the captured catalogue's own `subject.migration_count: 37`
(`crates/nostream-storage/tests/fixtures/schema.json`). No table, column or index outside that
contract is added here, and the same tree is what the Postgres arm is migrated from.

**The seam therefore stays 9 of the capture's 10 repositories.** The tenth is
`user_subscriptions`: it has a TypeScript repository
(`src/repositories/user-subscription-repository.ts`) and no Rust trait, and the capture holds no
entry that exercises it, so it belongs to the job that adds that repository's slice.
`events.first_seen` is inside the contract and carries no index — the sqlx tree declares the
column (`crates/nostream-storage/migrations/20220524153400_create_events_table.sql:10`) and
indexes it nowhere — so this backend stores it in the row's JSON body, sets it at create and
preserves it across a replace, and seeks nothing by it.

The two knex migrations the sqlx tree lacks are closed elsewhere, each by the job that first needs
it:

- `migrations/20261016_120000_create_user_subscriptions_table.js` creates `user_subscriptions`
  and adds three nullable `invoices` columns (`plan_id`, `period_start`, `period_end`) — closed by
  the job that adds the capture's tenth repository.
- `migrations/20261025_120000_add_moderation_stats_first_seen_indexes.js` adds two partial
  `events` indexes on `first_seen` (`events_live_first_seen_pubkey_idx`,
  `events_live_first_seen_remote_address_idx`, built outside a transaction) and changes no column
  this store encodes — closed by the job that ports the moderation-stats query.

Both consequences — nine repositories of ten, and a `first_seen` stored but never indexed — are
stated in `lib.rs`'s "does not own" paragraph, which is where a reader of the crate meets them
first.

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
  1000 rows qualify; both return 1000 rows classified by the same precedence (Assumption 10
  in `spec.md`). The corpus is 483 events, so no current entry reaches it.
- A page is bounded by `MAX_PAGE_KEYS` and a read holds a page rather than a range; a count
  materialises no result set, and the ids it holds for a tag walk that can select a row twice
  are bounded by the same `MAX_PAGE_KEYS` — 270 352 B of resident set once full, however large
  the corpus, with a body decode per repeated key past the cap. So a client cannot choose how
  much a request materialises.
  The price is that a `#g`-prefix page walks its whole (time-bounded) range, an author page
  without kinds reads the created-at index, and so does an author × kind filter whose
  composition passes `MAX_PAGE_KEYS` ranges; an `ids` read whose criteria are exact is bounded
  by the request's own list, and a prefix criterion takes the bounded created-at scan.
- Two JSON values PostgreSQL's `jsonb` considers equal but that serialize differently
  (`1` against `1.0`) would be distinct deduplication pointers here; the repository builds
  the value in one shape and the relay passes a single string, so today's callers cannot
  reach it (Assumption 11).
