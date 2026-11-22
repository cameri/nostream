# ADR 0018: The user, invoice and report reads, and the split `user_admin` / `user_get`

- **Status:** accepted (job 037, Phase 2)
- **Deciders:** the rewrite team, on the operator's steer recorded in #1183 and this job's spec
- **Date:** 2026-11-21

## Context

Slice 4 of #1183 adds five MCP tools — `user_admin`, `user_get`, `invoices_list`, `invoices_get`
and `reports_list` — over repository seams that all exist. Nothing in
`crates/nostream-storage` changes: every method these tools call is already on a trait both
backends implement.

Four facts at the base commit shaped the slice.

**The scope is a property of the table row, not of the handler.** `Requires` is one field of the
door's `TOOLS` row, asked once per call at dispatch, and `Requires::Read` is the grant every
accepted document carries while `Requires::Write` needs the document's `write` scope. A single
`user_admin` tool covering both a balance read and an admission could only carry one of the two,
and a second check inside the handler would write no `mcp.denied` line, because the denial
record is written only at dispatch.

**`is_vanished` writes.** The trait's doc says the hydration is deliberate: on a pubkey with no
row it reads a live kind-62 and **stores** the answer, so a later call short-circuits. The
relay's gate is a write path with a budget for that; a door read is not.

**`find_pending_invoices` is the only list read on the invoice store**, and both backends
implement it pending-only: Postgres filters `status = 'pending'` and orders by `created_at`;
LMDB walks `invoices_pending`, an index holding only the pending rows. `confirm_invoice` sets
`amount_paid` and `confirmed_at` and leaves `status` alone, so a confirmed invoice stays in that
index until a status update moves it.

**`ReportRepository` has one listing, `find_actionable(limit)`**, and it is the repository's own
answer to the console's question: a report an operator allowed leaves the queue, and the queue is
newest first. There is no unfiltered listing, and on LMDB there is no ordered key to walk for
one.

## Decisions

### D1 — `user_admin` and `user_get` are two rows, because the scope is a row property

`user_admin` is one write tool whose arguments carry a pubkey and a closed `action` enum over
`admit`, `revoke`, `vanish` and `unvanish` — the shape `reports_action` established for a closed
set, with a hand-written `JsonSchema` stating the four literals as the schema's `enum`.
`user_get` is the read row: the row `find_by_pubkey` answers, and the balance that row carries,
in one payload.

The name is `user_get` because it is the same noun as `user_admin`, so the two rows sort next to
each other in `tools/list`; because the door already spells a single-document read
`<family>_get`; and because `status` is the door's word for liveness, not for a row.

Four write tools were rejected: four schemas, four handlers and four audit names for one
operator's four decisions about one pubkey.

**Cost:** the audit file cannot tell an admission from a revocation. Each dispatch line carries
`{"tool": …}` and nothing else — ADR 0017's `detail` rule forbids putting an argument value in it
— so an operator correlates the two by time. Paid for: one schema, one handler and one name for
four writes, and a read that is reachable with a document that grants nothing.

### D2 — The read path is `find_by_pubkey`, never `is_vanished`

Both tools read the same row, through one helper, so they cannot disagree about the row's shape
or the balance's source. One read answers both fields: `find_by_pubkey` answers `None` for a
pubkey with no row and `Some(row)` — carrying `row.balance` — for a row, so `balance` is `0` for
a pubkey with no row and the row's own number otherwise. `get_balance_by_pubkey` would answer
the same two values from a second load of the row just decoded — a second query on Postgres, a
second decode on LMDB — and its reading could land after a credit the first did not see, which
is two snapshots in one answer. `None` versus `Some(row)` is what distinguishes no row from no
funds, and `user_get`'s description says so.

The pair was not even outcome-identical where a row's `balance` was NULL, which the migration
allows (`20230107230901_create_users_table.sql:4` carries no `NOT NULL`): the row read coalesces
it to `0` (`postgres/users.rs:24`), and the removed read's bare `try_get` would have failed on
the same row (`postgres/users.rs:130`).

`is_vanished` is called by neither tool. It hydrates a live kind-62 into a stored row, and
`user_get` is reachable with a document that carries no scope at all — so calling it would make
a read write, leaving a row behind for every pubkey anyone inspects. The stored flag is what the
payload reports.

**Cost:** a pubkey whose only vanish evidence is a kind-62 the relay's cache never saw reads as
absent, and an operator must run `user_admin vanish` to make it visible. Paid for: no write under
a read-only grant, and one meaning for the flag.

### D3 — `user_admin`'s payload is `action`, the row after the call and the balance — never a count

`admit_user` returns `()`, `set_vanished` returns an upsert count that is always one, and
`revoke_admission` returns a match count. One `changed` field would mean three different things.
The row as it stands after the call is the same answer for all four actions: `user` null when the
pubkey has no row, `balance` `0` for that same pubkey.

**Cost:** a caller cannot tell that `admit` created the row rather than updating it, and a revoke
of an admitted row and a revoke of an already-false row answer an identical payload — both end
`is_admitted: false`, and the store counts one for each. Paid for: one payload shape for four
actions, and a store read-back instead of a number whose meaning depends on which arm ran.

### D4 — `reports_list` is the actionable review queue, and a full listing is priced rather than built

The tool takes a `limit` and no other argument, and answers `find_actionable(limit)`'s rows in the
store's own order. Its name, description and payload say "the review queue": a report an operator
allowed has left the queue, and the queue has no offset, so there is nothing to page.

A full listing — every report, a filter by `actionable` or `report_type`, an offset — is one new
trait method on six implementors, a parity arm, and an unordered LMDB scan that materialises and
sorts the whole table. It was measured at `find_stored`'s price, 15 files and +196/−19, and it is
out of scope here, named with its price so a later slice takes it deliberately.

**Cost:** a report an operator allowed is not listable through MCP at all, and the queue cannot be
paged past 500. Paid for: zero storage code in this slice.

### D5 — `invoices_list` is pending-only, and `invoices_get` answers a miss as a result

`invoices_list` takes `offset` and `limit`, passes them to `find_pending_invoices`, and answers
`{"invoices": [...]}` with no re-sort and no `truncated` marker: a caller pages with `offset`, and
the store's own `(offset, limit)` is the whole protocol. A marker no repository state can decide
would be a guess.

`invoices_get` takes the id verbatim — no hex prefix, no length rule, no normalisation — because
`invoice.id` is opaque text by migration, and an id that happens to be 64 hex characters is a
valid id. A miss answers `{"invoice": null}` with `isError: false`, as `get_event` answers an
unknown event id.

**Cost:** an operator cannot list a completed or expired invoice — only read one by id — and the
pending list keeps a confirmed invoice until its status moves, which the two descriptions state so
a caller is not misled. Paid for: no new invoice read on either backend.

### D6 — One page bound for the two new list tools

`MAX_ROWS_PER_PAGE` is both the default and the ceiling, held by one `page_bound` that reproduces
the events' existing rule and refusal text byte for byte; the events' page size becomes a call to
it and converts the answer at its own site. A second 500 would be the same number in two places,
and the payments worker's `PENDING_INVOICE_PAGE_SIZE` is that worker's page rather than a bound
the door states.

**Cost:** `reports_list` has no offset, so a queue longer than 500 is unreadable past the first
page, and `invoices_list`'s offset walks a live index, so a pending row that leaves the queue
between two pages — its status moving off `Pending`, which the payments worker's expiry does —
shifts the walk, and a row can be skipped or answered twice. Insertion cannot: the index is
`created_at ‖ id` ascending, so a new invoice lands after the cursor. Paid for: one number and
one message for the three tools that page.

### D7 — The absent-name example moves to `maintenance_run`, and five audit names land

ADR 0017 left `user_admin` as the standing example of a tool that does not exist, in three test
sites and one crate-doc sentence. `user_admin` exists now, so the example moves to
`maintenance_run`, slice 5's name, which no constant, row or handler carries — and the parity of
the example is a grep, so it is checked rather than assumed.

The audit vocabulary gains `mcp.user_admin`, `mcp.user_get`, `mcp.invoices_list`,
`mcp.invoices_get` and `mcp.reports_list`, each composed by `audit_action` from the tool's own
constant. Every one carries `{"tool": …}` and nothing else: no pubkey, no action, no invoice id,
and no `remoteAddress` for a stdio caller. ADR 0014's table is extended with all five.

**Cost:** the example must move again when slice 5 lands, and the criterion for it is a grep
rather than a compile error. Paid for: three sites that keep testing what their sentences claim,
and a denial record that names the tool whose scope was missing.

## Consequences

The surface is twelve tools, eight of them reads. `tools_list.json` is regenerated from the live
server and compared, never rewritten by a test. The four lists that count the tools — the crate
docs, `--help`, `CONFIGURATION.md` and the test headers — say twelve, eight and four.

Nothing under `crates/nostream-storage` moves: no trait method, no backend arm, no parity step.
A slice that finds it needs one has mis-cut the work, and that is an escalation rather than a
quiet addition.

`set_vanished(false)` has its first caller in the tree. Because the relay's gate reads the stored
flag, clearing it lets a pubkey publish again; the events a kind-62 request deleted are not
restored, and the tool's description says so.
