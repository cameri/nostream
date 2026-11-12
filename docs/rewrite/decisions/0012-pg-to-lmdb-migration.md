# ADR 0012: The Postgres-to-LMDB migration (job 029)

- **Status:** accepted (job 029, Phase 2)
- **Deciders:** the rewrite team, on the evidence in job 029's recon and spec
- **Date:** 2026-11-11

## Context

The rewrite's store becomes LMDB, and the relay that is running holds its data in the
Postgres schema ADR 0003 defines. Cutover therefore needs one operation the repository did
not have: a copy of every table from the Postgres store into an LMDB store, resumable after
a crash, with a record of what it moved so the result can be checked before anything is
pointed at it.

The nine repository traits cannot carry that copy. No trait enumerates a table — every read
is a filtered query — and every write is shaped like "a new row now": `create` stamps
`first_seen` with the clock, the invoice insert clears `amount_paid` and `confirmed_at`,
`UserPatch` carries neither `balance` nor `created_at`, and the outbox and delivery-log
inserts mint fresh ids. A trait-only copy would be both lossy and partial, which is the one
thing a cutover tool must not be.

This document records the twelve decisions the tool rests on, each with the reason it was
taken.

## The copy goes through a migration-only seam (D1)

`nostream_storage::migration` is a new module with two traits — `MigrationSource` and
`MigrationTarget` — and the rows they move. It exists for `nostream-cli migrate pg-to-lmdb`
and for no other caller; its doc comment says so, and a second caller needs a record of its
own first.

The alternative was to implement the copy in the CLI, and it loses on three counts. The
Postgres row decoders are in-crate, the event column list is private to the crate
(`postgres/sql.rs`), and eight of the nine LMDB per-table write paths already exist in
`lmdb/`. A CLI-side copy would restate nine column lists and nine index write paths and
drift from the ones the relay uses. The seam is also the only place where "write this row
exactly" can sit beside the write paths it has to agree with.

The seam compiles with no driver: the two implementations are `#[cfg(feature)]` and the
vocabulary is not, so `cargo check -p nostream-storage --no-default-features --all-targets`
still passes and a build that links neither backend can still name a `MigrationRow`.

The cost is a public surface in a crate that documents what it does not own. The crate's
`lib.rs` says which half it owns — the seam, not the tool — and the doc comment on the
module repeats it where an implementor meets it.

## Nine tables, two stated limits (D2)

`MigratedTable` has nine variants: `dvm_jobs`, `events`, `invite_codes`, `invoices`,
`nip05_verifications`, `notification_delivery_log`, `notification_outbox`, `reports`,
`users`. They are the tables the store has a repository and a database for.

Two of the capture's tables are not moved, and both are stated limits rather than omissions:

- `event_tags` is a trigger-maintained index in Postgres. LMDB's `tags` database is written
  from the event row itself by the event write path, so copying the table would duplicate
  what the event write already produces.
- `user_subscriptions` has a TypeScript repository and no Rust trait, and no LMDB database
  (ADR 0011). It is that repository's slice to build, not this tool's to invent.

`MigratedTable::NOT_MIGRATED` carries both names and the manifest prints them, so an
operator reading the result sees the two tables the store does not hold instead of having to
know.

## Every column is preserved, through migration-only writers (D3)

Each row goes to LMDB through a writer that puts the source's own key and value and every
index entry that table's existing write path writes, and stamps, clears and defaults
nothing. `events` is the one table whose write set had to be composed: the value, the
created-at index, the author index, the tag index and the expiring index are the set
`write_event` writes, the `replaceable` pointer is what `write_upserted` writes, and an
`events_deleted` entry is what `soft_delete` writes — so a migrated soft-deleted or expired
row, which never passed through `soft_delete`, gets both tail entries from the migration
writer itself.

`users.tos_accepted_at` is carried, which no trait write can do: the seam's `User` omits the
column deliberately (`fromDBUser` drops it), so the seam carries the pair
`MigratedUser { user, tos_accepted_at }`.

One field is lost, and it is lost on purpose. `events.id` is the Postgres v4 uuid, no LMDB
reader uses it, and the store does not keep it. It is dropped from the canonical projection
so a source row and the same row read back from the store stay comparable.

## The canonical projection and its checksum (D4)

`MigrationRow::canonical` is `serde_json` of the row — so the enum's variant tag is part of
the bytes — after exactly two normalisations: `EventRecord::row_id` is set to `None`, and
every `DateTime<Utc>` is truncated to the microsecond precision a PostgreSQL `timestamp`
column has. Both are what makes a source row and its stored copy project identically.

The checksum is the 256-bit sum of per-row `SHA-256(len32 ‖ key ‖ canonical)`, added
modulo 2^256. Three properties made that shape the choice: the sum does not depend on the
order rows are read in, it needs constant memory over a table of any size, and it composes
across a resume (`sum(A ∪ B) = sum(A) + sum(B)`), so an interrupted run continues the number
it had rather than starting again.

It is a corruption and completeness check — any added, removed or altered row moves it — and
not a cryptographic commitment, and it is not a defence against a deliberate collision.
Nothing here needs one.

## Resume is per table, and a replay is one batch (D5)

The manifest holds, per table, a keyset cursor `after`, the accumulated `rows` and
`checksum`, and `complete`. A run resumes each incomplete table at its cursor and seeds the
count and the sum from the entry.

The store commit and the manifest write cannot share a transaction through the public
surface, so the batch is committed first and the manifest is replaced atomically second — a
temporary file, synced before the rename, and the directory synced after it. Both syncs are
load-bearing: a rename is durable only when the directory entry is on disk, and a manifest
that survives as a name pointing at a truncated file is worse than a missing one, because
`read_manifest` refuses it and the target refusal below then blocks the store it describes.
The manifest is written 0600 and through an exclusively created temporary file: it records the
last key written per table, and for `invite_codes` that key is the invite code itself — a bearer
credential NIP-43 accepts — so a world-readable manifest would hand one out, and a planted link
at the temporary path must not be written through and renamed into place.
A crash between the two therefore replays at most one batch,
which is harmless because every write in it is a put of the source's own key and value: the
same rows produce the same count and the same sum, so the merged entry is unchanged.

For the first batch that replay has nothing to fall back on, so the run writes the manifest
fresh before its first read: every table `rows: 0`, the zero checksum, `after: ""`,
`complete: false`. A store this tool has begun to fill therefore always carries a manifest, and
the refusal of a store that is not this tool's stays what it should be — a judgement about rows
that appeared without one, not about a crash.

Two refusals guard the target, and they are the same judgement from two sides. A store that holds
rows and carries no manifest is not this tool's: copying over it would leave the displaced rows'
index entries behind, and verify reads the primary databases only, so the run refuses before it
reads anything. A manifest that records progress — a row counted, a cursor moved, a table
finished — is only meaningful beside the store that progress went into, so the run requires
`data.mdb` to be a file there and refuses a missing one instead of creating it; a copy over an
empty store would skip the tables already counted and exit 0 against a store missing every row
the manifest claims. The file test cannot tell a store the run wrote from a truncated one that
still has a `data.mdb`, so a second refusal covers that shape: a table the manifest counts rows
for must hold at least one row, or the store beside the manifest is not the one the run wrote
to. A manifest with no progress cannot have written a row, so a fresh store beside
it is honest and the run starts one.

## The command surface (D6)

The source is named before it is dialled. With nothing configured, `PostgresBackend::from_env`
falls back to `postgres@localhost:5432/postgres`, so the run refuses at once and names `DB_URI`
and the `DB_*` parts rather than copying whatever a local server happens to hold; a source that
cannot be reached is reported as the database it could not read — host and database, password
dropped — instead of as the pool's acquire timeout a minute later.

A target that is a symlink, writable by group or other, or owned by another user, is refused
before anything is opened: the copy writes the dataset into `<target>/lmdb`, so a writable
target lets another local user pre-place the store and read what lands in it, an owner can
replace the directory between the check and the open whatever its bits say, and a link sends
the copy somewhere the operator did not name. The owner is compared with the process's
effective uid, read from `/proc/self/status`, because `std::fs` exposes the file's owner but
not the caller's and the alternative was a dependency for one integer. The target the run
writes into is printed with the summary.

`nostream-cli migrate pg-to-lmdb` takes `--target <DIR>`, `--batch-size <N>` and `--verify`,
and nothing else. `--target` is required with no default: a default of the working directory
would let a mistyped run write a store where none was meant, and verify needs it too because
the manifest lives under it. `--batch-size` defaults to 1 000, the import's default, and its
minimum is 1: a batch of zero would never advance a cursor. `--verify` copies nothing and
reads only the target.

Verify creates no store and no manifest: it requires `<target>/lmdb/data.mdb` to be a file
before it opens anything, and opens through `LmdbBackend::open_existing`: a read-only
environment, no `create_dir_all`, every database opened by name rather than created. That
opener commits the read transaction it opens those handles in, because heed publishes a
database handle only once its opening transaction has committed: a dropped read transaction
leaves the handles unusable, and the next transaction on them answers `Invalid argument` —
which a fresh process, having no earlier committed open to inherit them from, hits on its
first read. Every in-process test misses it, because the store was opened writable first.
LMDB's read-only open is not entirely a read: it recreates `lock.mdb` beside an existing
`data.mdb` (measured), and a target directory it cannot create that file in is refused. The
ordinary opener would answer a verify of a store that is not there with a fresh empty
environment and nine short tables — a check that reports corruption it caused. heed's
process-global registry answers `BadOpenOptions` for a second open of one path with different
options, and it holds the environment process-wide, so dropping a handle does not free the
path. That is why the resume check asks whether `data.mdb` is there instead of opening the
store read-only first: the writable open that follows would otherwise refuse the one case the
check exists to allow.

A re-run resumes wherever the manifest says the last one stopped; deleting
`<target>/migration-manifest.json` starts a new copy, and the command's help and its refusal of
a store the manifest counts rows for both say so.

Exit codes are the CLI's own, from `CLI.md`: 0 on success, 2 for a usage error, 1 for every
other failure, which is written to stderr as `Migration failed: {message}`. That message
needs a `CliError` variant of its own — reusing `Import` would report `Import failed:` for a
migration — so `CliError::Migrate` exists and `main` prints it with its own prefix.

The help text states the one precondition nothing can check (see below) and names the source:
Postgres from `DB_URI`, else the `DB_*` parts.

## The manifest (D7)

The manifest is `<target>/migration-manifest.json`: `format: 1`, `not_migrated` with the two
table names, and one entry per table carrying `rows`, `checksum`, `after` and `complete`.

It carries no timestamp, no rate and no path. That is what makes two runs over the same
source produce byte-identical manifests, and what lets an interrupted-then-resumed run be
compared with a clean one as bytes rather than as a parse. It also keeps a source URL out of
a file that may be copied around.

The checksum string is sixty-four `0` characters for an empty table, so an entry is always
present and always well formed.

## Throughput is the run's own measurement (D8)

The copy measures the wall clock from just before its first read to just after its last
write and prints two lines:

```
Migrated {total} rows in {ms} ms
Events throughput: {rate} events/s
```

`total` is the rows this invocation wrote, and the rate is `events * 1000 / max(ms, 1)` over
the `events` table only. Both numbers are plain digits so a reader can recompute the rate
exactly, and the rate comes from the same integers that were printed.

**No floor is asserted.** The board's 50 000 events/s target belongs to the benchmark rig,
which does not exist; a CI runner's rate is not that number, so this tool reports what it
measured and claims nothing about it.

## The relay must be stopped (D9)

Both stores are documented preconditions of a run, printed in the command's help: the relay
must be stopped on both.

The reason is that nothing in this repository proves a second process may hold the LMDB
environment. LMDB's lock file would let one in, and heed opens with no flags beyond the
verify opener's `READ_ONLY`, so the locking protocol is active — but the daemon opens no backend of its own today, so
sharing is untested rather than known-safe. The tool takes no lock of its own: a lock that
nothing else honours is worse than a documented precondition, because an operator would read
it as protection.

## A refused row stops the run (D10)

A row the store refuses — a tag value at the 469-byte key bound, a NUL in a text key — fails
the batch and stops the run. The message names the table, not a batch ordinal, so an
operator knows which row stopped the copy, and the manifest keeps the previous batch's
cursor, count and sum, so the next run resumes at the refused row.

Nothing is skipped and no table is marked complete. Skipping would leave the target missing
a row while the manifest's checksum still counted it, which turns a row an operator can look
at into a verify failure after a full copy.

## The report sequence moves with the rows (D11)

`reports.id` is carried across, and after each batch `meta`'s `reports.next_id` is raised to
the largest migrated id in that batch — never lowered, and left alone by a batch with no
report. A later `ReportRepository::create` then allocates past the migrated rows instead of
colliding with them.

## The source is read-only (D12)

The migration issues no `INSERT`, `UPDATE`, `DELETE` or DDL against Postgres, does not run
the embedded migrator, and runs no statement but the nine paged reads. Its schema contract
is the migrations' own, so a source that has not been migrated fails with the driver's
error rather than being repaired in place.

A read that repaired its source would be a second writer on a live relay's database and
would make a failed run something an operator has to undo.

## What this record does not decide

- No throughput floor: the benchmark rig owns that number.
- No cutover, and no judgement that the migrated store is fit to serve.
- No migration of `user_subscriptions` or `event_tags`.
- No reverse migration, and no migration between two Postgres databases.
- No change to the nine traits, the LMDB encodings, the database list, the Postgres schema,
  `LMDB_MAP_SIZE`, `LMDB_MAX_DBS` or the maximum key length.
