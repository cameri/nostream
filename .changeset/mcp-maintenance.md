---
---

feat(mcp): the maintenance tools, the counts the pass drops, and the run record

The admin MCP server gains `maintenance_run`, which runs the maintenance pass's retention purge
in the answering process through the same `MaintenanceService` the worker's `MaintenanceTasks`
arm delegates to, and `maintenance_last_run`, which reads the last run this process recorded.

`MaintenanceService::clear_old_events` now answers `EventPurgeCounts` instead of `()`, the
`MaintenanceTasks` trait's future carries them, and `PassOutcome` gains
`counts: Option<EventPurgeCounts>` — `None` on a failed or timed-out purge, never zeros. Every
implementor and test double moves with it; `crates/nostream-storage` is untouched.

The run record lives in `AdminState`'s process memory (`MaintenanceRun`: `ranAt`, `deleted`,
`expired`, `retained`), so "never ran" is `null` and "ran, nothing to purge" is three zeros. ADR
0019 records the six decisions, including why the door runs the purge step rather than the whole
pass and why the record is not a sixth key in the published status document.

Rust only: no version bump.
