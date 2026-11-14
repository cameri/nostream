# Benchmarks: the LMDB store on the rig's workload

The numbers in this document come from one command on one host, and from the artifact that
command wrote, committed beside this document:

`docs/rewrite/benchmarks/lmdb-50k-seed7.json`

Nothing else is cited. The rig is `crates/nostream-storage/examples/bench.rs`: one workload,
held as named constants in that file and echoed into the artifact's `workload` object, run
through `Arc<dyn EventRepository>` so the same call sites measure either backend.

Two columns are deliberately absent, and the sections below say why: the Rust/Postgres column,
which needs a database this host does not have, and the TypeScript/Postgres column, which is
#1132's job. Neither carries a figure here.

## The recorded run

| | |
|---|---|
| Date | 2026-11-14 |
| Machine | 4 CPUs, `Intel(R) Core(TM) i7-10700T CPU @ 2.00GHz` |
| Load average, one minute | 43.92 |
| Free disk at run time | 12 GB (`df -h /`) |
| Profile | `release` |
| Repeats | 3 (`workload.repeats`) |
| Command | `cargo run --release -p nostream-storage --example bench -- --backend lmdb --events 50000 --seed 7 --repeats 3 --verify --out /tmp/bench-lmdb-1.json` |
| Artifact | `docs/rewrite/benchmarks/lmdb-50k-seed7.json` |

The machine, the load average and the store's size are `volatile.machine` and `volatile.store`
in that artifact. This host is shared: the load figure is other tenants' work on four cores, and
the three repeats below measure what that does to the numbers rather than leaving it to a
sentence.

## The LMDB numbers

**Within one run.** One row per shape, from the artifact's `shapes` and the first repeat's
`volatile.timings`.

| shape | count | rows | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---|---|---|---|---|
| `create_many` | 98 | 49000 | 41.7 | 100.6 | 1097.4 |
| `create` | 1000 | 1000 | 3.7 | 6.5 | 8.2 |
| `by_id` | 200 | 200 | 0.0 | 0.1 | 0.1 |
| `author_kind` | 200 | 20000 | 0.3 | 0.4 | 0.4 |
| `kind_since` | 200 | 99602 | 1.4 | 2.1 | 2.3 |
| `tag` | 200 | 20000 | 0.3 | 0.4 | 0.5 |
| `count` | 50 | 1020000 | 9.6 | 19.5 | 21.8 |
| `read_back` | 1 | 50000 | 20.5 | 20.5 | 20.5 |

Every column here is the artifact's own integer printed as-is (the `count`, `rows` and `ops`
numbers), except the three percentile columns, which are the artifact's microsecond integers
printed in milliseconds with exactly one decimal, rounding half-up: `19 514` µs prints as `19.5`,
and `0` µs would print as `0.0`. `read_back` carries no `shapes` entry: it is the single
unbounded count the corpus is read back with, and its `rows` is `event_count_read_back`.

`count` is one repository call. `rows` is the sum over the shape's calls, which is why
`kind_since` shows 99602 rows at a limit of 500 — two hundred pages, most of them full — and why
`count`, which carries no limit, sums every match of every iteration.

**Across the three repeats.** One row per shape, from `volatile.repeats`. The band is what this
rig exists to publish: a point estimate from one run of a shared host is not a measurement of the
store.

| shape | per_second median | p10 | p90 | rows_per_second median | p10 | p90 |
|---|---|---|---|---|---|---|
| `create_many` | 20 | 16 | 44 | 10009 | 8345 | 22483 |
| `create` | 243 | 85 | 270 | 243 | 85 | 270 |
| `by_id` | 39131 | 37757 | 47653 | 39131 | 37757 | 47653 |
| `author_kind` | 2943 | 2729 | 3131 | 294334 | 272966 | 313116 |
| `kind_since` | 678 | 651 | 700 | 338042 | 324696 | 348817 |
| `tag` | 3315 | 3308 | 3447 | 331543 | 330846 | 344750 |
| `count` | 98 | 94 | 105 | 2012445 | 1922779 | 2142195 |
| `read_back` | 48 | 36 | 52 | 2433800 | 1802711 | 2649287 |

Every figure is the artifact's integer printed as-is: `median`, `p10` and `p90` are the
nearest-rank percentiles over the three repeats' rates, and the rule is the one the within-run
percentiles use, applied to three numbers instead of hundreds.

`per_second` counts operations: one event for `create`, one five-hundred-event batch for
`create_many`, one filter query for a read shape, one count for `count`. `rows_per_second` counts
the rows those operations returned. The two differ for `create_many` by its batch size, which is
why the same column reads 20 operations and 10009 rows, and they coincide for `create` and for
the read shapes that always return one row per operation.

**The store.**

| events | data_bytes | bytes_per_event |
|---|---|---|
| 50000 | 94490624 | 1889.8 |

`events` and `data_bytes` are the artifact's integers as-is; `bytes_per_event` is
`data_bytes / events` rounded to one decimal, so it is not the artifact's own truncated integer.
`data_bytes` is `data.mdb`'s length, which includes pages LMDB allocated and has not reused yet,
so it overstates live bytes — the safe direction for the disk arithmetic in D5.

## The workload

### D1 The corpus

Generated, not loaded: event `i` of `N` at seed `s` has an id of `i` and `s` little-endian in
its first bytes, an author of `i % 200` over 200 authors, a kind from the cycle
`[1,1,1,1,1,1,1,1,7,7]` taken at `(i % 200 + i / 200) % 10` — the author's ordinal plus the block
the event falls in, so every author writes both kinds while every 200-event block keeps the
cycle's proportions — `created_at = 1700000000 - (i % 2592000)`, a 256-byte content of the index
in hex then `x`, and one tag `["t", "bench-{i % 20}"]` over 20 values. The run recorded here used
seed 7. Identical input produces identical bytes, which is what makes two runs comparable: the
second run's artifact, with `volatile` removed, is identical to this one. The signature is zero
bytes, because nothing on the store path verifies one.

### D2 The two write shapes

`create_many` is corpus loading: the first 49000 events, 500 per call, one commit per batch.
`create` is ingest: the last 1000 events, one call per event, and it is the shape the relay
itself uses — `crates/nostream-relay/src/strategies/default.rs:36` is
`context.stores.events.create(&record)`. A rig that loaded the corpus with `create_many` and
called that ingest would measure an API the relay never calls, which is why the two are separate
rows and only `create` speaks for ingest.

### D3 The five read shapes, and the access path each reaches

Each shape is one filter through `find_by_filters`, drained to rows with `collect_records`, so
the measurement covers the whole page and not just its first batch. The LMDB planner picks the
path in `crates/nostream-storage/src/lmdb/events.rs`:

- `by_id` — `ids`, limit 1: the `events` key is the id, so the range runs in id order
  (`events.rs:1303-1316`).
- `author_kind` — one author and kind 1, limit 100: the author × kind index
  (`events.rs:1317-1334`, ranges built by `author_kind_ranges`).
- `kind_since` — kind 1 from a moving `since`, limit 500: the created-at index
  (`events.rs:1345-1351`).
- `tag` — one `["t", …]` value, limit 100: the tags index (`events.rs:1353-1362`).
- `count` — kind 1 to a moving `until`, no limit: `count_by_filters`, which reads only the fixed
  header of each candidate (`docs/rewrite/decisions/0011-lmdb-backend.md:61-73`) and therefore
  scales with the number of matches rather than with the page.

Every window is derived from the corpus's own `created_at` span, so every iteration matches
events: `count` reads 1020000 rows over its 50 iterations and its median is a real scan of
milliseconds, not the empty range a window sized from the calendar month produced.

### D4 Concurrency, warm-up, and what a timing is

Concurrency is 1: one writer and one reader, no concurrent load, no background traffic. There is
no warm-up pass and the first iteration counts. A timing is the repository call alone — one
`create`, one `create_many` batch, one filter query, one count — measured around the await at the
call site, with the corpus generation outside it. Nothing here is a socket round trip: the wire is
out of scope.

The reads are warm, not cold: the store is written immediately before it is read, and 94490624
bytes of `data.mdb` fits this host's memory, so a read shape pays the page cache's hit rather
than its miss. A cold-cache run is a different measurement and this rig does not make one.

The write shapes are not stable between repeats, and the band above is the evidence rather than a
claim about it: `create`'s per-second rate spans 85 to 270 across the three repeats. The read
shapes move much less — their bands are a fraction of that width — except `read_back`, which is
one operation per repeat and so is a single sample each time. The cost being timed for the writes
is LMDB's synchronous commit, which waits on a shared host's disk, so the write rows are one
host's measurement under load 43.92 and not a bound. A reader comparing two hosts should compare
the read shapes first.

### D5 The corpora measured, and the ones that were not

Measured here: 50000 events, seed 7, three repeats, on the store the harness creates under a
temporary directory. The harness's default ceiling is what keeps a mistyped corpus from filling a
disk: a run above it is refused before the store is touched, with the projected store size printed
in bytes and `--allow-large-corpus` named as the override.

The gate's 1M and 10M corpora (#868) were not measured here: this host had 12 GB free at run
time, and the store's own measurement projects:

projection: 1M events (#868) x 1889.8 bytes/event = 1889800000 bytes
projection: 10M events (#868) x 1889.8 bytes/event = 18898000000 bytes

Both are projections from this run's bytes per event, not measurements, and the 1M run alone
(#868) would need the `--allow-large-corpus` override on a host with room for it.

### D6 The Rust/Postgres column: not measured in this environment

The second Rust backend is the same `EventRepository` over the same workload, run with
`--backend postgres`. It is not measured in this environment: the measuring host has no Docker
daemon, no `psql` and no Postgres server, so the harness refuses the run rather than skipping it
(`PARITY_ADMIN_URL must name an administrative database, …`).

CI reaches it, because CI's `Rust Checks` job already runs a Postgres service. Two steps in
`.github/workflows/checks.yml` carry the rig there: `Benchmark harness against Postgres` runs the
same binary and the same `--verify` in the dev profile, and its timings are cited nowhere; and
`Benchmark harness unit tests` runs the harness's own tests, which `cargo test --workspace` would
only have compiled. On a host with Postgres the number comes from:

```
PARITY_ADMIN_URL=postgres://postgres:postgres@host:5432/postgres \
  cargo run --release -p nostream-storage --example bench -- \
  --backend postgres --events 50000 --seed 7 --repeats 3 --verify --out /tmp/bench-postgres.json
```

The Postgres arm drops and recreates the scratch database `nostream_bench_rust` on the server
that URL names, so it belongs only where that name is expendable.

### D7 The TypeScript/Postgres column: not measured

The baseline implementation is `src/` on `main`, and this branch's `src/` is not it: the tree has
already lost the modules the Rust crates replaced, so a run from this worktree would measure
neither implementation. This host also has no `node_modules` and no Docker, so neither the relay
nor the Postgres it needs can be started here. That column, and the side-by-side comparison the
gate reads, is filed as #1132 and must be run from a checkout of `origin/main` on a host with a
Docker daemon.

### D8 No threshold is asserted

This document carries evidence, not a pass/fail. The gate is #868: REQ p95 within 1.5× of the
Postgres implementation and ingest ≥ 1×, at the 1M and 10M corpora (#868). The board's
50 000 events/s figure is a target tracked in #864, not a measurement, and nothing here is
compared with it. No ratio, floor or comparison against another backend appears in this
document.

## How a run reports itself

The harness's contract is three exit code values, the same ones `--help` states:

- exit code 0 — the run completed, and with `--verify` every check passed.
- exit code 1 — a verify failure: one `verify failed: <field>: expected <x>, got <y>` line on
  stderr per failed check, with the artifact written anyway so the failure can be read.
- exit code 2 — a usage error, a refusal, or a failure that stopped the run.

A refusal is answered before the store is opened and prints one line: a corpus below the minimum
or above the ceiling, a `--out` directory that does not exist, a `--repeats` below one, a store
directory that already holds one, a Postgres run without `PARITY_ADMIN_URL`, or a running `rustc`
— a build on the same box distorts the numbers about threefold, so pass `--allow-busy-host` only
when the measurement is a smoke test. Progress goes to stderr, so stdout never carries anything a
script would parse.

## Context from job 007, not this rig's numbers

ADR 0003 records the Postgres figures one review session measured
(`docs/rewrite/decisions/0003-storage-seam-and-postgres.md:219-233`): `count_by_filters` 267.6 ms,
a multi-value `#p` `EXISTS` 44.9 ms, and `claim_batch` 12.2 ms. They are context from job 007's
review and the provenance it names; they are not this rig's output, they were not re-measured
for this document, and no table above cites them.
