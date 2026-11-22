# ADR 0019: The maintenance tools, the counts the pass drops, and the run record

- **Status:** accepted (job 038, Phase 2)
- **Deciders:** the rewrite team, on the operator's steer recorded in #1183 and this job's spec
- **Date:** 2026-11-21

## Context

Slice 5 of #1183 adds the family's last two MCP tools, `maintenance_run` and
`maintenance_last_run`, and the one API change the family carries: the retention purge's counts
stop being dropped. Four facts at the base commit shaped the slice.

**The counts are computed, used once in a log line, and dropped — twice.**
`MaintenanceService::clear_old_events` takes `EventPurgeCounts` from the store, logs them when the
total is positive, and answers `Ok(())`. The `MaintenanceTasks` trait's own
`clear_old_events` then flattens that into
`Result<(), ServicesError>`, and `MaintenanceRunner` passes it straight through, so nothing
outside the service can see a count. The storage layer already answers the counts on both
backends, and none of its ten implementors moves.

**The door cannot reach the worker, and that is the slice's hard fact.** The MCP server is served
only in `nostreamd --mcp-stdio`, which returns before the daemon's `serve` loop starts and
composes its own `AdminState` over the unwired repository bundle. The daemon's
`MaintenanceWorker` is built in `spawn_workers` and discarded with its tasks field private and no
getter. The two modes are alternatives, so "the same pass the worker runs" can only mean the same
code path — the trait, the runner and the service — and never the daemon's live instance.

**Nothing records a pass today.** `publish_heartbeat` writes the three run fields as `None` every
45 s, so the daemon's `maintenance` row is `{type, updatedAt}` and nothing else. The counts exist
only in the service's log line. The published status document is pinned to five keys by a case,
and the probe ring has no producer.

**The retention guard's skip is a real answer.** With `maxDays` absent, not positive, or absent
because `limits.event.retention` is unset, the repository is not called and the service answers
success. A counts-returning service therefore has two distinct answers — three zeros with no
call, and whatever the store counted — and the tools have to keep them apart.

The slice also has to move the absent-name example: `maintenance_run` was the last planned name,
so registering it leaves no planned name to stand for a tool that does not exist.

## Decisions

### D1 — `clear_old_events` answers `EventPurgeCounts` at both layers, and the pass carries them as an `Option`

The service answers the store's counts, and the guard's arm answers
`EventPurgeCounts::default()` **without calling the store** — a skip is not a purge of nothing.
The trait's future carries `EventPurgeCounts`, `MaintenanceRunner` passes the service's answer
through, and the scripted double answers a fixed non-zero value so the pass's own carrying of the
value is observable. `PassOutcome` gains `counts: Option<EventPurgeCounts>`, filled only on the
arm where the purge completed: a failed, panicked or timed-out purge has no counts.

The alternative — `PassOutcome { counts: EventPurgeCounts }` with zeros on failure — was rejected
because a timed-out purge that reports `{0,0,0}` is indistinguishable from a pass that found
nothing to do, and the operator reading the record would believe the second.

**Cost:** one `Option` the loop still discards — `run_pass`'s outcome is dropped at the tick, so
the counts are observable only through `run_pass`'s return value and the door's own call. The
value exists for the tests and for the next reader of the pass; the loop's cadence and its
four-step order are untouched.

### D2 — `maintenance_run` runs the purge step through `MaintenanceService`, in the answering process, with no cap of its own

The tool runs the same function the trait's `clear_old_events` arm delegates to, over the
answering process's store bundle and the merged settings it reads per call. It does not build a
`MaintenanceRunner`, because a runner needs the notification outbox, the payments service (which
needs the relay key source and the relay's broadcast hub) and the NIP-05 fetch, and the stdio
mode composes none of the first two. It does not add a third `MaintenanceTasks` implementor
either: three of that trait's four steps would have to answer a refusal nothing calls.

The 5 000 ms cap is `run_pass`'s, and it protects the loop's cadence. A caller that asked for the
purge and is waiting for its answer has the client's own deadline, as every other door tool has;
the tool adds no second timeout and reports none.

**Cost:** "the same pass the worker runs" is realised as the pass's purge step, not its four
steps — NIP-05 re-verification, the outbox walk and the invoice walk stay the loop's. Paid for: a
door call that cannot log three errors per call over an unwired store, and no invented
constructors. An operator who wants all four steps runs the daemon.

### D3 — The last-run record lives in `AdminState`'s process memory

`MaintenanceRun` holds `ran_at` (the clock's ISO-8601 instant) and the three counts. The door's
own `maintenance_run` records it — replacing the previous value, never summing into it — and
`maintenance_last_run` answers `{"run": <object|null>}`, one `AdminState` read and no store call.
"Never ran" is `null`; "ran and purged nothing" is an object of three zeros, which the retention
guard makes a real distinction. The record is not a `WorkerHeartbeat` field, not a sixth key in
`relay-status.json`, and not a file.

The alternatives cost more than the fact is worth here: a file needs a writer inside
`MaintenanceWorker` (which has no clock and no path), a TTL policy and a second writer rule
beside the audit file's; a sixth key in the published document is an amendment to ADR 0016 for a
value the daemon did not produce when this record was written.

**Cost:** the record is **this process's own**. A door run beside a daemon is a supported
deployment, not an excluded one: the stdio mode is its own process over the same config
directory (ADR 0014), the published status document exists so a door can report facts a running
daemon produced (ADR 0016), and `CONFIGURATION.md` examples the door over that directory. Beside
a running daemon, `{"run": null}` therefore means "**this** process has not run one", not "no
pass has run": the daemon purges on its own tick and its passes are invisible here. That is a
known blind spot, not a fact, and the tool's description says so in its own words. D3 accepts it
because the alternative — a durable record — was priced above this slice (Consequences names it
as the successor).

### D4 — The run is a `Requires::Write` row and the read is a `Requires::Read` row, and neither detail carries a count

`maintenance_run` is in the table's write set and `maintenance_last_run` in its read set, so a
document with no scopes reads the record and is refused the purge with one `mcp.denied` line.
Both lines carry `{"tool": …}` and nothing else: `dispatch_detail` gains no arm, and no count and
no retention value enters the audit file.

**Cost:** the audit file cannot say how much a run purged, or which retention it used; an operator
correlates by time through `maintenance_last_run`. Paid for: a caller's own numbers never shape a
record, and a read-only document still reads the record.

### D5 — The absent-name example becomes `no_such_tool`

`#1183`'s names are all registered after this slice, so the example can no longer be a *planned*
name: it moves to the literal `"no_such_tool"` at the three test sites, and the crate doc's
"outside this surface" sentence is deleted, because there is no longer a family to point at.

**Cost:** the example no longer doubles as a statement about future work. It tests only what its
cases claim — a name the table does not carry is refused before the scopes and writes no line —
and a synthetic name cannot be overtaken by a later slice, which is the failure this example has
had twice.

### D6 — `EventPurgeCounts` gains no `Serialize`

The record's wire names — `ranAt`, `deleted`, `expired`, `retained` — are `MaintenanceRun`'s,
filled from the counts' three public fields. `crates/nostream-storage` does not move at all: no
trait method, no backend arm, no derive.

**Cost:** the parity harness's key names and the payload's are now two spellings that a test has
to keep equal, rather than one derive that would make the storage crate the authority on a wire
shape. Paid for: the storage crate keeps answering a struct, and the admin crate owns the JSON
that crosses the pipe.

## Consequences

The surface is fourteen tools: nine reads and five writes. `tools_list.json` is rendered from the
live server and compared, never rewritten by a test. The four lists that count the tools — the
crate docs, `--help`, `CONFIGURATION.md` and the test headers — say fourteen, nine and five.

`MaintenanceService::clear_old_events` and the `MaintenanceTasks` trait answer
`EventPurgeCounts`; `PassOutcome` carries `counts: Option<EventPurgeCounts>`. The pass's
four-step order, the 5 000 ms cap, the 60 000 ms interval, the overlapping-tick skip and the
retention options forwarded verbatim are unchanged.

Nothing under `crates/nostream-storage` moves. `ServiceStores` keeps its eight fields, because
the purge needs `events` and the settings and nothing else.

A durable, cross-process record is the **named successor** to D3, not a gap left unnamed. The
daemon now produces the counts (`PassOutcome.counts`), so what is missing is only the writer and
the read path: a sixth key in the published document — an amendment to ADR 0016's five — or a
record written by whichever process runs a pass, which needs a writer inside `MaintenanceWorker`
with a clock and a path, and a TTL. The next slice that has to read a daemon's passes must
resolve it; until then a door's `null` beside a daemon is the blind spot D3's cost states.
