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
| Date | 2026-11-15 |
| Machine | 4 CPUs, `Intel(R) Core(TM) i7-10700T CPU @ 2.00GHz` |
| Load average, one minute | 48.79 (`volatile.machine.load_1min`, the first repeat's) |
| Free disk at run time | 33 GB (`df -h /`) |
| Profile | `release` |
| Repeats | 3 (`workload.repeats`) |
| Command | `cargo run --release -p nostream-storage --example bench -- --backend lmdb --events 50000 --seed 7 --repeats 3 --verify --out /tmp/bench-lmdb-1.json` |
| Artifact | `docs/rewrite/benchmarks/lmdb-50k-seed7.json` |

The machine, the load average and the store's size are `volatile.machine` and `volatile.store`
in that artifact. This host is shared: the load figure is other tenants' work on four cores, and
the three repeats below measure what that does to the numbers rather than leaving it to a
sentence. The load is sampled before every repeat, not once: `load_1min_by_repeat` holds `48.79`,
`48.73` and `48.69`, so the one-minute figure above is the first of three readings that agree.

## The LMDB numbers

**Within one run.** One row per shape, from the artifact's `shapes` and the first repeat's
`volatile.timings`.

| shape | count | rows | p50 (ms) | p95 (ms) | p99 (ms) | per_second | rows_per_second |
|---|---|---|---|---|---|---|---|
| `create_many` | 98 | 49000 | 22.2 | 31.2 | 32.7 | 43 | 21985 |
| `create` | 1000 | 1000 | 3.8 | 4.6 | 4.9 | 256 | 256 |
| `by_id` | 200 | 200 | 0.0 | 0.1 | 0.1 | 36784 | 36784 |
| `author_kind` | 200 | 20000 | 0.3 | 0.4 | 0.5 | 2813 | 281333 |
| `kind_since` | 200 | 99602 | 1.5 | 1.7 | 2.0 | 660 | 328819 |
| `tag` | 200 | 20000 | 0.3 | 0.3 | 0.3 | 3531 | 353150 |
| `count` | 50 | 1020000 | 10.7 | 18.2 | 18.9 | 95 | 1953259 |
| `read_back` | 1 | 50000 | 20.4 | 20.4 | 20.4 | 48 | 2446902 |

Every column here is the artifact's own integer printed as-is (the `count`, `rows`, `ops`,
`per_second` and `rows_per_second` numbers), except the three percentile columns, which are the
artifact's microsecond integers printed in milliseconds with exactly one decimal, rounding
half-up: `31 162` µs prints as `31.2`. The cost of that rule is the `by_id` row, whose calls take
tens of microseconds and print as `0.0`; the artifact's integers are the measurement, and this
table is a reading of them. `read_back` carries no `shapes` entry: it is the single unbounded
count the corpus is read back with, and its `rows` is `event_count_read_back`. The rates are the
first repeat's, like the percentiles.

`count` is one repository call. `rows` is the sum over the shape's calls, which is why
`kind_since` shows 99602 rows at a limit of 500 — two hundred pages, most of them full — and why
`count`, which carries no limit, sums every match of every iteration.

**Across the three repeats.** One row per shape, from `volatile.repeats`. The band is what this
rig exists to publish: a point estimate from one run of a shared host is not a measurement of the
store.

| shape | per_second median | p10 | p90 | rows_per_second median | p10 | p90 | p95 (ms) median | p10 | p90 |
|---|---|---|---|---|---|---|---|---|---|
| `create_many` | 45 | 43 | 45 | 22673 | 21985 | 22890 | 30.6 | 30.1 | 31.2 |
| `create` | 254 | 251 | 256 | 254 | 251 | 256 | 4.7 | 4.6 | 4.7 |
| `by_id` | 37615 | 36784 | 48732 | 37615 | 36784 | 48732 | 0.0 | 0.0 | 0.1 |
| `author_kind` | 3202 | 2813 | 3344 | 320210 | 281333 | 334476 | 0.3 | 0.3 | 0.4 |
| `kind_since` | 660 | 659 | 734 | 328819 | 328382 | 365695 | 1.7 | 1.5 | 1.7 |
| `tag` | 3552 | 3531 | 3679 | 355220 | 353150 | 367944 | 0.3 | 0.3 | 0.3 |
| `count` | 109 | 95 | 111 | 2229576 | 1953259 | 2275323 | 18.2 | 17.2 | 18.2 |
| `read_back` | 48 | 21 | 54 | 2446902 | 1084857 | 2703141 | 20.4 | 18.5 | 46.1 |

Every figure is the artifact's integer printed as-is, except the three `p95` columns, which are
`volatile.repeats.<shape>.p95_us` in milliseconds under the same one-decimal rounding as the
table above. All five bands are in the artifact — `p50_us`, `p95_us` and `p99_us` beside the two
rates — because the cutover gate reads a p95, and a band on the rates alone would leave the number
it compares without one.

**What a band is.** Each band is the nearest-rank percentile of the shape's per-repeat values:
sort the `n` values ascending and take the one at position `ceil(p ÷ 100 × n)` — the first value
whose position reaches `p` per cent of the samples. With three repeats the tenth percentile is
the smallest value, the median the middle one and the ninetieth the largest; with two, the median
is the lower of the two rather than their mean. One repeat is a point, not a band: the artifact
still carries the three fields, and all three hold that single value, so a one-repeat artifact's
band is the measurement printed three times and is not evidence of stability.

`per_second` counts operations: one event for `create`, one five-hundred-event batch for
`create_many`, one filter query for a read shape, one count for `count`. `rows_per_second` counts
the rows those operations returned. The two differ for `create_many` by its batch size: the
within-run row above reads 43 operations against 21985 rows in the same second, and the band's
medians differ by the same factor. They coincide for `create` and for the read shapes that always
return one row per operation.

**The store.**

| events | data_bytes | bytes_per_event |
|---|---|---|
| 50000 | 94490624 | 1889.8 |

These are `volatile.store`, read from the first repeat's store: the repeats write the same corpus
in the same order, so the first one's size stands for all three, and taking it there keeps this
block describing the same repeat as `volatile.timings` and `shapes`. `events` and `data_bytes` are
the artifact's integers as-is; `bytes_per_event` is
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

Each repeat writes the whole corpus into a fresh store and reads it with the same corpus-derived
windows, so a repeat's rate is the same workload under a different moment on the host, and the
band across repeats is the spread of that moment — not a spread of the workload.

The two rates divide by the time the shape's calls took, added up, not by its median: a shape
whose few slow calls carry the total has a rate below `1 / p50`, so a reader who recomputes a rate
from the percentile columns above gets a number the artifact does not record.

On this run both write shapes agreed closely between repeats — `create`'s per-second band spans 251
to 256, `create_many`'s 43 to 45, and its `p95` band runs from 30.1 to 31.2 ms around a median of
30.6 — which is what makes the write rows worth reading as a measurement of this host on this day.
The widest bands belong to the shapes measured least often: `read_back` is one operation per repeat,
and `by_id`'s band runs from 36784 to 48732 per second across calls that take a few tens of
microseconds, so one stalled call moves it. A repeat on a shared host can stall outright, and
nothing in the rig prevents it, so the band — and not one run's number — is what the tables above
are for. A run whose band is wider than this one's is a reading of a busier host, not of a slower
store.

The cost being timed for the writes is LMDB's synchronous commit, which waits on a shared host's
disk; `create_many` also copies the batch and writes its indexes, and this rig does not separate
the two. The write rows are one host's measurement at load 48.79 and not a bound. A reader
comparing two hosts should compare the read shapes first.

### D5 The corpora measured, and the ones that were not

Measured here: 50000 events, seed 7, three repeats, on the store the harness creates under a
temporary directory. The harness's default ceiling is what keeps a mistyped corpus from filling a
disk: a run above it is refused before the store is touched, with the projected store size printed
in bytes and `--allow-large-corpus` named as the override.

The gate's 1M and 10M corpora (#868) were not measured here. Disk space rules neither out on this
host: the 1M projection fits easily inside the 33 GB the run recorded free, and so does the 10M
one. Both are #868's runs because they are the gate's corpora and this job's scope is the
recorded one, and each needs `--allow-large-corpus` wherever it runs. The cost of the `count`
shape, which scans its whole match set per iteration, grows with the corpus and belongs in that
run's budget too.

projection: 1M events (#868) x 1889.8 bytes/event = 1889800000 bytes
projection: 10M events (#868) x 1889.8 bytes/event = 18898000000 bytes

Both are projections from this run's bytes per event, not measurements, and each would need the
`--allow-large-corpus` override on a host with room for it.

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
Postgres implementation and ingest ≥ 1×, at the 1M and 10M corpora (#868). That p95 comparison
reads the band, not one run: the artifact carries `p95_us` per shape across repeats so the median
and the width are both available, and a single run's p95 inside a band as wide as `read_back`'s
above cannot decide a margin of one and a half on its own. #868's rule does not say which statistic
of the band the ratio applies to, and a band that straddles the threshold — one repeat inside the
margin, another outside it — is exactly the case that rule has to settle; this document measures
and does not decide it. The board's 50 000 events/s figure is a target tracked in #864, not a
measurement, and nothing here is compared with it. No ratio, floor or comparison against another
backend appears in this document.

The artifact's `schema` integer is its layout version: the artifact this document reads — the
committed `docs/rewrite/benchmarks/lmdb-50k-seed7.json` — is schema 2, and a field whose meaning
or position changes takes the next number, so a consumer can tell which shape of document it holds.
Version 2 added `workload.reads.by_id_stride` and `workload.reads.by_id_offset`: without them two
artifacts that step through the corpus differently were the same document.
A consumer that meets an unknown value should refuse the artifact and name the version it found,
the way `crates/nostream-storage/src/lmdb/encoding.rs:184-193` refuses a value written by a
different row format rather than reading it as if it were this one.

### D9 The deliberate exclusions, and where the workload is defined

The workload is one shape of the relay's traffic, and what it leaves out was decided rather than
overlooked. Its definition is the constants at the top of
`crates/nostream-storage/examples/bench.rs` — one file, and the workload's single definition —
echoed into the artifact's `workload` object so a published result can be traced back to the
definition that produced it. A change to any of those constants makes a new workload, not a new row
in the tables above, and a result from a changed workload is not comparable with this one.

Not measured, and why:

- **Replaceable kinds and `upsert`.** Kinds 0, 3, 41, 10000–19999 and 30000–39999 reach `upsert`
  (`crates/nostream-storage/src/repositories.rs:494`) — the parameterized replaceable range
  through `crates/nostream-relay/src/strategies/parameterized_replaceable.rs:35`, reached from
  `strategies/mod.rs:102-103` — because the relay replaces the current version of such an event
  rather than appending another. Ephemeral kinds 20000–29999 are never stored at all
  (`crates/nostream-core/src/event.rs:247-250`) and reach no repository call — except 28934, 28935
  and 28936, which the invites and users arms claim before the ephemeral arm is reached
  (`strategies/mod.rs:90-96`), and which the rig does not exercise: 28934 spends an invite and
  admits the user (`join_request.rs:100`, `:118`), 28936 revokes the admission
  (`leave_request.rs:91`), and a client-published 28935 is refused without touching a store
  (`invite_request.rs:33-38`). The rig times the default arm's append, and the arms that re-enter
  `create` — delete, gift wrap, DVM job request, group, report, timestamp and vanish, beside the
  default arm itself (`strategies/default.rs:36`, `delete.rs:105`, `gift_wrap.rs:38`,
  `dvm_job_request.rs:30`, `group.rs:37`, `report.rs:35`, `timestamp.rs:40`, `vanish.rs:37`) — are
  the same call with a different row, so a corpus using them measures what the `create` shape
  measures. Only the replaceable families need `upsert`, which the rig does not call; adding one
  would change what a corpus row means, not just add a shape.
- **Retention and purge.** `delete_expired_and_retained` and the reconciliation scans are separate
  calls over the same tables, and a corpus written in one sweep measures none of them.
- **NIP-50 `search`.** It is on the base — `Filter.search` is
  `crates/nostream-core/src/filter.rs:67`, Postgres builds `ts_rank`/`plainto_tsquery` over it
  (`postgres/sql.rs:225-231`), and the LMDB arm answers `StorageError::NotImplemented` for it
  (`lmdb/events.rs:1061-1072`, ADR 0011's `:331`). What keeps it out of the tables is the gate:
  both arms honour `search` only with `nip50.enabled`, and the harness opens either backend without
  settings (`LmdbBackend::open`, `PostgresBackend::connect`), so with the gate off a filter carrying
  `search` is measured as the plain filter underneath it, the query silently dropped. A `search` row
  added to this rig as it stands would therefore time a filtered read and call it a search; a
  Postgres-only row would be one-sided, since the LMDB arm cannot answer one at all. A real search
  benchmark starts by opening the store with the gate on, and that is its own job.
- **Transactions.** The Postgres arm pays for serializable transaction groups the LMDB arm does
  not have; the rig times repository calls, not the grouping above them.
- **Concurrency above one.** One writer, one reader, `concurrency: 1`: no concurrent readers, no
  subscriber fan-out and no live dispatch. A store's cost under contention is a different figure.
- **The wire.** Nothing here is a socket round trip (D4).

A later job that adds any of these is measuring a different workload, and should say so where its
numbers are published instead of comparing them with the tables above.

## How a run reports itself

The harness's contract is three exit code values, the same ones `--help` states:

- exit code 0 — the run completed, and with `--verify` every check passed.
- exit code 1 — a verify failure: one `verify failed: <field>: expected <x>, got <y>` line on
  stderr per failed check, with the artifact written anyway so the failure can be read.
- exit code 2 — a usage error, a refusal, or a failure that stopped the run.

A refusal is answered before the store is opened and prints one line: a corpus below the minimum
— the ingest phase takes the corpus's last thousand events, and the bulk phase needs one more to
have anything to load — or above the ceiling, a `--out` directory that does not exist, a
`--repeats` below one, a `--store` directory that already holds a store at any path the repeats
would open, a Postgres run without `PARITY_ADMIN_URL`, or a running `rustc` — a build on the same
box distorts the numbers about threefold, so pass `--allow-busy-host` only when the measurement is
a smoke test. Progress goes to stderr, so stdout never carries anything a script would parse.

## Context from job 007, not this rig's numbers

ADR 0003 records the Postgres figures one review session measured
(`docs/rewrite/decisions/0003-storage-seam-and-postgres.md:219-233`): `count_by_filters` 267.6 ms,
a multi-value `#p` `EXISTS` 44.9 ms, and `claim_batch` 12.2 ms. They are context from job 007's
review and the provenance it names; they are not this rig's output, they were not re-measured
for this document, and no table above cites them.
