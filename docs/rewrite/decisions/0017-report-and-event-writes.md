# ADR 0017: The two event and report writes, and the report store at the door

- **Status:** accepted (job 036, Phase 2)
- **Deciders:** the rewrite team, on the operator's steer recorded in #1183 and this job's spec
- **Date:** 2026-11-21

## Context

Slice 3 of #1183 adds two MCP tools, `delete_event` and `reports_action`, and the repository
plumbing both need. Three facts at the base commit shaped it.

**The tree has exactly one single-event delete, and it is soft.** `EventRepository`'s
`delete_by_pubkey_and_ids` takes the pubkey **as well as** the ids, so a caller that has not read
the row cannot call it truthfully; both backends skip a row whose pubkey does not match. Its rules
are the store's, implemented twice and nowhere else: the row keeps its value with `deleted_at`
set, kind 62 is never touched, an already-deleted row is not re-deleted, and the return value is
the count of rows flipped. The relay compensates on its read path only (a subscription drops a row
whose `deleted_at` is set); the two MCP event tools read through `collect_records` and
`collect_page`, which do not, so a soft delete leaves the row visible to `get_event` and
`list_events`.

**`Report.actionable` is a create-time property that nothing ever changes.** The report strategy
writes it from `is_trusted_moderator`, one row per extracted target, so one report event with
three targets writes three rows with the same `event_id`. LMDB denormalises the flag into three
indexes at write time and no function removes one; the NIP-56 gate reads two of them per query.
The relay's `HiddenContentCache` is a mirror of actionable **targets** — a latency optimisation for
live fan-out, refreshed wholesale every 30 s — and not the source of truth.

**The door cannot see the report store.** `AdminState` carries `Arc<ServiceStores>`, and that
bundle's seven repositories did not include reports; the relay has its own `Stores` for six, and
the MCP mode composes its own state in a process of its own.

## Decisions

### D1 — `delete_event` is the store's own soft delete behind one ungated read, and its payload says what that means

The tool resolves the row through **one new `EventRepository` method**, `find_stored(&EventId)` —
an exact-id read that returns the row whether or not it is deleted and **whether or not an
actionable report hides it**. LMDB answers it with one `get` on the events table, Postgres with one
`SELECT ... WHERE event_id = $1`, and the eight other implementors carry it — the relay's and the
services' in-memory and unavailable doubles, the admin test's `SlowEventRepository`, the door's
`VanishingRepository` and `ZeroCountDeleter`, and the storage test's `Noop` — every one of them
truthfully: a double that answered `None` for a row would redden the case that relies on it, and
the hidden-event case runs over the real backend rather than a double.
It exists because the gate has always been a read's (`lmdb/events.rs:1968-1978`'s `reported`, one
predicate of a filter's row walk, and `postgres/sql.rs`'s equivalent): resolving the row
through `get_event`'s gated read made `reports_action hide` followed by `delete_event` answer
`not_found` and delete nothing, which made the two tools this slice ships incoherent with each
other. The method is `pub` on a trait every consumer holds, so "only the delete path may call it"
is not left as a comment: `.find_stored(` is an acceptance leg that reads exactly two lines across
`crates/`, both the handler's, so a third caller using the method-call form fails the criterion. The
leg is a deterrent, not a proof — a fully qualified `EventRepository::find_stored` spells past it,
and the parity cases themselves use that form — which is why the doc comment states the rule as
well; the commit that adds a parity caller is the place to see the leg is a spelling's.

The argument is the event's hex id, and a prefix shorter than 64 characters is refused with the
same `Criterion` error `reports_action` gives rather than widened to whatever the store's range
would match — the `EventId` the read takes is an exact id, so answering `not_found` for characters
the tool never looked up would be the one lie this tool must not tell.

The call is `delete_by_pubkey_and_ids` with **the row's own** pubkey and id, then one read-back,
and the answer is `{outcome, event}` with one of four literals: `deleted`, `already_deleted`,
`not_deleteable` (kind 62), `not_found`. The outcome is decided by the row **as it stands after**
the call, not by the read before it: a pre-read is stale under two deletes in flight, and the
second call would answer `not_deleteable` for a row that was merely already deleted. `count > 0`
stays authoritative; the post-read only explains a zero, and kind 62 is the store's only remaining
skip once the pubkey is the row's own.

The event leaves REQ and COUNT and keeps its row: `get_event` and `list_events` still return it
with `deleted_at` set — **unless an actionable report hides it**, in which case it stays hidden
until the report is allowed, and deleting it does not change that. Both halves are stated in the
tool's description rather than left for an operator to discover, and the read-back makes the
timestamp the store's own wall-clock value instead of a guess.

**Cost:** a soft delete is not an erasure: the row and its content stay in the store, and an
operator who needs the bytes gone still needs the retention path or `clean-db`. The disclosure is
prose, so a client that reads only the schema learns nothing about it; the cheap alternative — a
fifth outcome — was rejected because the store's answer is already one of four. Three store round
trips per call (read, delete, read-back), all on the answering process's own store. The ungated
read is a second way to reach a row, which is why it is one method with one caller and a criterion
guarding the call count rather than a flag on the read path.

### D2 — `reports_action` acts on the report's own event id and flips one row's flag per row

The argument is the report's **own** kind-1984 event id, exactly 64 hex characters — the
`find_by_event_id` argument, no new reader — and `hide` means `Report.actionable = true`, `allow`
means `false`. One call flips every row the report event wrote, returns the rows sorted by `id`
and `changed`, the rows whose value moved. The sort is the handler's and the contract's: LMDB's
prefix walk happens to answer ascending by `report_id`, and Postgres does not order, so relying on
either would be relying on an accident — which is why the branch's report seam reverses what the
store answers and the case goes red when the sort is removed. An id with no rows
answers `{"reports": [], "changed": 0}` — a result, as an unknown id is for `get_event`. An
unknown action never reaches the handler: the closed set is the arguments type's deserialiser and
the schema's `enum`.

**The action is one row's flag, not a recomputation across reports.** A target named by two
actionable reports stays hidden while the other remains actionable — which is what the flag means
and what `find_actionable_targets`' dedup already implements. Discovery is stated, not invented: a
caller finds a report event with `list_events {"kinds": [1984]}` and acts on each row's own id,
and `reports_list` stays out of this slice and unowned.

**Cost:** a caller cannot act on a report whose kind-1984 event was never stored, because the
reports table is keyed by that id and reaching rows another way would need a reader no surface
has. Recomputing a target's actionability across all its reports would change
`find_actionable_targets`' contract; the flag's per-row meaning is the cheaper and already-written
rule.

### D3 — The report store reaches the door as a `reports` field on `ServiceStores`

`ServiceStores` gains `pub reports: Arc<dyn ReportRepository>`, and the door reads it as
`self.state.stores().reports`. Ten construction sites each name one value: `unavailable::stores()`
reuses `nostream_relay`'s `UnavailableReportRepository` (the dependency already exists), the admin
and MCP fixtures alias the `LmdbBackend` they already hold, and the services' tests and
`testing::context` use `nostream_relay::testing::InMemoryReportRepository`.

The alternative was an `AdminState` field, which is one field, one accessor and three
`AdminStateConfig` sites **plus** a new `compose` parameter with two callers — and it would put a
second report repository in the daemon's process beside the relay's own. The bundle is the tree's
existing answer to "the relay and services share repositories"; the console not reading the field
is the cost, paid once.

**The LMDB setter removes the three `reports_actionable_*` entries.** They are written by
`report_write` only when the flag is true, and nothing removed one; `find_actionable`,
`find_actionable_targets` and the gate read the indexes without re-checking the row, so a flip
that wrote only the value would leave every index stale. The setter deletes the row's keys,
rewrites the value with the new flag, and re-inserts the keys through `report_write` when the new
value is true — one write transaction, so a reader sees the old value or the new one. Postgres
needs one `UPDATE … WHERE event_id = $1 AND actionable <> $2` and no migration: the partial
indexes maintain themselves.

**Cost:** eight repositories in a bundle seven services call, one of which no services worker
touches; and the `InMemoryReportRepository` answers `Ok(0)` rather than modelling the setter,
because a double that modelled rows would have to model the three indexes too — a second
implementation of the thing under test, reached by no relay case. The double records the writes it
is given and answers every read empty, so `Ok(0)` is the count it can honestly produce rather than
a suppressed index constraint; a case that needs rows to move, like the ordering case, reads
through the door's own report seam instead.

### D4 — The hidden-content cache needs no work

The cache holds report **targets**, never events, and it is read only on live dispatch. A write to
`Report.actionable` needs no push from the door for three separate reasons. Every read answers
from the store per query on both backends, so a flip is in force for the very next
REQ/COUNT/`list_events` call, with no cache in that path. The live path converges by itself:
`refresh` re-reads `find_actionable_targets` every 30 s and `replace`s the snapshot wholesale,
which removes a target as well as adds one. And the door **cannot** reach the cache: it lives in
the relay process, `AdminState` holds no relay handle, and the stdio mode hosts no relay; the only
cross-process artifact is one-way (ADR 0016).

A delete leaves nothing in the cache to clear either: the mirror is keyed on report targets and
the delete writes no report row, so an event that is both deleted and a report target stays in the
mirror for exactly as long as its report stays actionable — the correct state, not a stale one.

**Cost:** the one consequence is disclosure, not mechanism — every new REQ reflects a flip at
once, and already-connected subscriptions see it at the relay's next refresh, up to 30 s. It is
said in the tool's description and here, and no test can reach a second process's memory.

### D5 — The audit vocabulary gains two names, and their `detail` is the tool and nothing else

`mcp.delete_event` and `mcp.reports_action` join the per-tool actions, composed by `audit_action`
from the `TOOL_*` constants, and both rows in the dispatch table need `Requires::Write`. Their
`detail` is `{"tool": …}` — no id, no action — because passing either would let a caller's own
text shape a record; `settings_set` passes the requested paths only because the paths are the
request itself. The line is written at dispatch, before the handler, so a refused id still leaves
its `mcp.reports_action` line and an argument the schema refuses leaves none. ADR 0014's table is
extended with both names.

**Cost:** an operator reading the file cannot tell which event was deleted or which report was
acted on; the correlation is by time and by the caller's own record. That is the deliberate
direction: the file is a record of calls, and its fields are the table's, not the caller's.

### D6 — The absent-name example moves to `user_admin`

Two cases are right today only because `delete_event` is the standing example of a tool that does
not exist (`an_unknown_tool_is_a_protocol_error` and `an_unregistered_tool_is_refused_before_the_scopes`),
and one assertion passes afterwards for the wrong reason if it is left alone
(`required_scope("delete_event")`). All three move to `user_admin`, slice 4's first tool, which no
slice has landed, and test files name tools through the exported `TOOL_*` constants so no literal
stands in for a registered name.

**Cost:** the next slice that lands `user_admin` must move the example again, and the criterion is
a grep rather than a compile error, so the mistake is found by a case rather than by the type
checker.

**And the grep is over `.rs` sources only.** Its pattern is an absolute absence of the literal
`"delete_event"` in the test sources, while the snapshot fixture under the same directory must
carry a `"name": "delete_event"` entry — data, not a case. A pattern that read the fixture as a
case would make the snapshot criterion and this one unsatisfiable together, so the criterion names
`--include=*.rs` and says why; the base reading is unchanged (three lines at `443cb985`, all in
`.rs` files).

ADR 0019 moved the example on once more, to `no_such_tool`, when the last planned name landed.
