# Benchmarks: the LMDB store on the rig's workload

The numbers in this document come from one command on one host, and from the artifact that
command wrote, which is committed beside this document:

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
| Date | 2026-11-13 |
| Machine | 4 CPUs, `Intel(R) Core(TM) i7-10700T CPU @ 2.00GHz` |
| Load average, one minute | 43.34 |
| Free disk at run time | 19 GB (`df -h /`) |
| Profile | `release` |
| Command | `cargo run --release -p nostream-storage --example bench -- --backend lmdb --events 50000 --seed 7 --verify --out /tmp/bench-lmdb-1.json` |
| Artifact | `docs/rewrite/benchmarks/lmdb-50k-seed7.json` |

The machine, the load average and the store's size are `volatile.machine` and `volatile.store`
in that artifact. The load figure matters: this host is shared, and two runs of the same command
have differed by several times on the write shapes, whose cost is LMDB's synchronous commit.

## The LMDB numbers

One row per shape, from the artifact's `shapes` and `volatile.timings`.

| shape | count | rows | p50 (ms) | p95 (ms) | p99 (ms) | per_second |
|---|---|---|---|---|---|---|
| `create_many` | 98 | 49000 | 27.3 | 39.5 | 48.5 | 35 |
| `create` | 1000 | 1000 | 3.9 | 4.7 | 5.4 | 254 |
| `by_id` | 200 | 200 | 0.0 | 0.0 | 0.1 | 46674 |
| `author_kind` | 200 | 16000 | 0.3 | 0.4 | 0.6 | 3610 |
| `kind_since` | 200 | 100000 | 1.5 | 1.7 | 2.3 | 663 |
| `tag` | 200 | 20000 | 0.3 | 0.3 | 0.4 | 3594 |
| `count` | 50 | 40000 | 0.0 | 0.0 | 18.4 | 2654 |
| `read_back` | 1 | 50000 | 19.2 | 19.2 | 19.2 | 52 |

The `count` and `rows` columns are the artifact's integers printed as-is (rule a), and so is
`per_second`; the three percentile columns are the artifact's microsecond integers printed in
milliseconds with exactly one decimal, half-up (rule b). `read_back` carries no `shapes` entry:
it is the single unbounded count the corpus is read back with, and its `rows` is
`event_count_read_back`.

| events | data_bytes | bytes_per_event |
|---|---|---|
| 50000 | 94191616 | 1883.8 |

`events` and `data_bytes` are the artifact's integers as-is (rule a); `bytes_per_event` is
`data_bytes / events` rounded to one decimal (rule c), which is why it is not the artifact's own
truncated integer.

The percentiles are nearest-rank over the per-call samples, so `p50` of a shape with one
operation is that operation. `per_second` is the shape's operations against the time they took.

## The workload

### D1 The corpus

Generated, not loaded: event `i` of `N` at seed `s` has an id of `i` and `s` little-endian in
its first bytes, an author of `i % 200` over 200 authors, a kind from the cycle
`[1,1,1,1,1,1,1,1,7,7]`, `created_at = 1700000000 - (i % 2592000)`, a 256-byte content of the
index in hex then `x`, and one tag `["t", "bench-{i % 20}"]` over 20 values. The run recorded
here used seed 7. Identical input produces identical bytes, which is what makes two runs
comparable: the second run's artifact, with `volatile` removed, is identical to this one. The
signature is zero bytes, because nothing on the store path verifies one.

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

`count` is the shape that shows the difference: its median is a fraction of a millisecond while
its tail is the width of the corpus, because the first iterations count every kind-1 event.

### D4 Concurrency, warm-up, and what a timing is

Concurrency is 1: one writer and one reader, no concurrent load, no background traffic. There
is no warm-up pass and the first iteration counts, so the figures include the cost a cold page
cache adds. A timing is the repository call alone — one `create`, one `create_many` batch, one
filter query, one count — measured around the await at the call site, with the corpus generation
outside it. Nothing here is a socket round trip: the wire is out of scope.

The write shapes measure LMDB's synchronous commit, since the environment is opened with default
flags (`crates/nostream-storage/src/backend.rs`). On this shared host they vary between runs of
one command by several times; the figures above are one recorded run, not a bound, and a reader
comparing two hosts should compare the read shapes first.

### D5 The corpora measured, and the ones that were not

Measured here: 50000 events, seed 7, on the store the harness creates under a temporary
directory. The harness's default ceiling is what keeps a mistyped corpus from filling a disk: a
run above it is refused before the store is touched, with the projected store size printed in
bytes and `--allow-large-corpus` named as the override.

The gate's 1M and 10M corpora (#868) were not measured here: this host had 19 GB free at run
time, and the store's own measurement projects:

projection: 1M events (#868) x 1883.8 bytes/event = 1883800000 bytes
projection: 10M events (#868) x 1883.8 bytes/event = 18838000000 bytes

Both are projections from this run's bytes per event, not measurements, and the 1M run alone
(#868) would need the `--allow-large-corpus` override on a host with room for it.

### D6 The Rust/Postgres column: not measured in this environment

The second Rust backend is the same `EventRepository` over the same workload, run with
`--backend postgres`. It is not measured in this environment: the measuring host has no Docker
daemon, no `psql` and no Postgres server, so the harness refuses the run rather than skipping it
(`PARITY_ADMIN_URL must name an administrative database, …`).

CI reaches it, because CI's `Rust Checks` job already runs a Postgres service. The step is named
`Benchmark harness against Postgres` in `.github/workflows/checks.yml`, and it runs the same
binary and the same `--verify` in the dev profile; its timings are cited nowhere. On a host with
Postgres the number comes from:

```
PARITY_ADMIN_URL=postgres://postgres:postgres@host:5432/postgres \
  cargo run --release -p nostream-storage --example bench -- \
  --backend postgres --events 50000 --seed 7 --verify --out /tmp/bench-postgres.json
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

## Context from job 007, not this rig's numbers

ADR 0003 records the Postgres figures one review session measured
(`docs/rewrite/decisions/0003-storage-seam-and-postgres.md:219-233`): `count_by_filters` 267.6 ms,
a multi-value `#p` `EXISTS` 44.9 ms, and `claim_batch` 12.2 ms. They are context from job 007's
review and the provenance it names; they are not this rig's output, they were not re-measured
for this document, and no table above cites them.
