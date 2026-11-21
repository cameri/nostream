---
---

feat(mcp): add the delete_event and reports_action tools

`delete_event` marks one stored event deleted through the store's own soft delete: the event
leaves REQ and COUNT, keeps its row, and the payload says so — `get_event` and `list_events` still
return it with `deleted_at` set unless an actionable report hides it, and the four outcomes are
`deleted`, `already_deleted`, `not_deleteable` (kind 62 is never deleted) and `not_found`. `reports_action` acts on a report's
own kind-1984 event id, flipping `Report.actionable` for `hide` and `allow` on every row that
event wrote.

The report store now reaches the MCP door as a `reports` field on `ServiceStores`, and
`ReportRepository` gains one setter: the LMDB arm moves the three denormalised
`reports_actionable_*` entries with the flag, so the NIP-56 gate and the actionable reads follow a
flip at once, and the Postgres arm is one `UPDATE` with no migration. The hidden-content mirror
needs no work: reads are gated per query and the mirror refreshes wholesale every 30 s.
`reports_list` remains out of scope and unowned.

Rust only; no published package changes. The decisions are in
`docs/rewrite/decisions/0017-report-and-event-writes.md`, and ADR 0014's audit table gains the two
`mcp.*` names.
