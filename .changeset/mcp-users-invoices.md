---
---

feat(mcp): five store-family tools — `user_admin`, `user_get`, the invoice reads and `reports_list`

`user_admin` carries the four decisions an operator makes about one pubkey — `admit`, `revoke`,
`vanish` and `unvanish` — as one closed action enum, and `user_get` reads the same row and its
balance under a document that grants nothing: the scope is a property of the `TOOLS` row, so one
tool would have made a balance read cost a `write` document or an admission reachable with a
read-only one. The read path is `find_by_pubkey` plus `get_balance_by_pubkey`, never
`is_vanished`, which hydrates a live kind-62 and stores a row — so `user_get` never writes.

`invoices_list` is the store's pending walk, oldest first, paged by `offset` and `limit`;
`invoices_get` takes the invoice's own opaque id verbatim and answers a miss as
`{"invoice": null}`, as `get_event` answers an unknown event id. `reports_list` is the review
queue over `find_actionable`: the reports still actionable, newest first, with no offset — a full
listing would be one new trait method on six implementors and is left for a slice that takes it
deliberately.

The two list tools share the door's one page bound (500, the default and the ceiling), and the
events' page size now goes through the same function. The audit vocabulary gains five `mcp.*`
names, each carrying `{"tool": …}` and nothing else. `docs/rewrite/decisions/0018-users-invoices-and-report-reads.md`
records the seven decisions. Rust only: no published package changes.
