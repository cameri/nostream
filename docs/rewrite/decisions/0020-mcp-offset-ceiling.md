# ADR 0020: The MCP invoice walk's skip ceiling

- **Status:** accepted (job 040, Phase 2)
- **Deciders:** the rewrite team, on the operator's steer recorded in #1183 and this job's spec
- **Date:** 2026-11-27

## Context

Slice 4 of #1183 gave `invoices_list` the first caller-chosen `offset` on the MCP surface, and
`limit` alone was bounded. #1223 records the gap: an `offset` of any `u64` reaches
`find_pending_invoices`, and both backends pay for the rows it passes rather than for the page it
answers — LMDB iterates the pending index one key at a time until the offset is reached
(`crates/nostream-storage/src/lmdb/invoices.rs`), and Postgres runs the partial index with
`OFFSET $2` (`crates/nostream-storage/src/postgres/invoices.rs`). The cost is a slow read and not
a wrong one: the read is granted, the rows are the operator's to see, and nothing is disclosed or
written.

Job 040's recon measured the shape on a temporary LMDB store holding 20,000 pending rows: the skip
is linear in the rows passed at about 0.09 µs per key, and it saturates at the pending set — 0.941
ms at `offset: 5_000` with `limit: 0` (the skip loop alone, best of five) and 1.562 ms at
`u64::MAX` for an empty page, against 7.936 ms for the 500-row page at offset 0. An offset above
the index costs the whole pending set, never the offset itself, so what is missing is a ceiling at
the door rather than a cheaper walk.

The two candidates were a ceiling and a keyset cursor. Both are priced below.

## Decisions

### D1 — A ceiling at the door, not a keyset cursor

The ceiling is enforced in `pending_invoices` before the repository call, and the store's
`(offset, limit)` protocol, both backend bodies and the trait are unchanged. The cursor would have
removed the cost rather than capped it, and its price in this tree is measured: `find_pending_invoices`
on six implementors, a new `repository-parity.json` step and its replay arm in
`crates/nostream-storage/tests/common/mod.rs`, and a Postgres `ORDER BY created_at, id` tie-break
that no test here can run, because this sandbox has no database. ADR 0018's consequences rule out
a storage move for these reads, and this door does not need one: the note recorded no disclosure
and no write, so what is being bounded is a read's cost.

**Cost:** paging stops at the ceiling, where a cursor would have removed the cost instead of
capping it. The ceiling is one constant, one function, one schema attribute, one snapshot and two
cases; the cursor is six implementors plus the parity harness, and its Postgres ordering cannot be
verified in this sandbox.

### D2 — The ceiling is `MAX_ROWS_PER_SKIP` = `nostream_storage::MAX_PAGE_ROWS` = 5,000

Chosen on the measurement rather than on a round figure. At 5,000 keys the skip costs 0.941 ms
against the 7.936 ms page the store already serves, so the ceiling bounds the walk at about a
tenth of the answer it precedes. A ceiling at the page bound (500) was rejected because at
`limit: 500` it leaves a caller two pages deep; 5,000 leaves eleven. The number is the tree's one
statement of what one answer may cost — the relay's clamp on event pages — so the API gains no new
number, and `MAX_ROWS_PER_SKIP` is a named constant beside `MAX_ROWS_PER_PAGE` so one place
decides both bounds a page has: the page itself and the walk that reaches it.

**Cost:** the ceiling's value aliases the relay's clamp, so the two move together unless a test
pins it — `tests/tools_list.rs` asserts `MAX_ROWS_PER_SKIP == 5_000`, which turns a silent move
into a failing case. A pending set deeper than 5,500 rows at `limit: 500` is unreachable through
MCP; that reach is what the bounded skip trades away, and nothing in the tree measures how deep a
real deployment's pending set is.

### D3 — The refusal is the door's, with one fixed text

`offset_bound` sits beside `page_bound`, defaults an absent offset to `0`, accepts any value at or
below the ceiling and refuses anything above it with
`offset: a walk skips at most {MAX_ROWS_PER_SKIP} rows, {offset} was given`, raised as
`McpError::Criterion` and rendered as an `isError: true` result. The schema carries the same number
through `#[schemars(range(min = 0, max = MAX_ROWS_PER_SKIP))]`, and the tool's description states
it, so the advertisement and the enforcement cannot drift. `page_bound` still runs first, so a call
with both arguments outside their bounds answers the `limit` text as it did before. The store never
sees a value above the ceiling from this door.

**Cost:** a non-MCP caller can still hand the repository any `u64`, so the store's `OFFSET` still
takes a negative value there — the `as i64` wrap stays a failed call and not a leak — and this door
pays for that with zero storage change. Paid for: one refusal a caller can act on, in the same
shape the page bound already uses.

## Consequences

The surface is unchanged: fourteen tools, and `invoices_list` takes the same two arguments. What
moves is the maximum the schema publishes and the reach of one call.

Nothing under `crates/nostream-storage` moves: no trait method, no backend arm, no parity step, no
migration. `find_pending_invoices` keeps accepting any `u64` from a caller that is not this door,
and the LMDB walk still answers an empty page past the index while the Postgres `OFFSET` still
fails at the driver for a negative value.

A keyset cursor remains the honest successor: it would remove the skip from both backends instead
of capping it at the door, at the price D1 states. Until a slice takes it, a caller pages at most
eleven pages deep at `limit: 500`, and the store's walk is bounded at 5,000 keys.
