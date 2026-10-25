---
---

fix(relay): order an inbound frame's prefix before the next frame is read

A per-socket handler ran as an independently scheduled task, so two frames read in order
could run in either order: a `CLOSE` handled ahead of its own `REQ` found nothing to abort
and the subscription kept streaming live events to a closed id, and a restricted `REQ`
pipelined behind its `AUTH` was refused for want of a session that had been sent but not
yet handled (cameri/nostream#958).

An inbound frame now runs its ordering-sensitive prefix — `subscribe` through its read
registration, `unsubscribe`, and `auth` — on the connection loop before the next frame is
read. The rest of the handler is spawned and stays concurrent, so a `CLOSE` during an
invite mint still aborts the stored read and the invite `EVENT` is still emitted. `EVENT`
and `COUNT` are unchanged.

The TypeScript tree is untouched: no `src/` or `test/` file changes, so the published
package has no user-visible change. The decision, the two rejected shapes and the
guarantee's boundary are recorded in
`docs/rewrite/decisions/0005-connection-concurrency.md`.
