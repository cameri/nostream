---
---

fix(relay): make a re-REQ keep its read, abort a read during the invite mint, and bound the outbound frame queue

Three concurrency defects in `nostream-relay`, found after the wire port and fixed
together because they meet in one per-socket task:

- A re-`REQ` replaces the read registered under a subscription id, and the replaced
  read's cleanup removed the replacement's cancellation sender, so a re-subscribed
  client could stop before `EOSE`. Reads now carry a connection-wide generation and
  `end_read` removes only its own entry.
- A `CLOSE` that arrived while the NIP-43 invite mint was in flight aborted nothing:
  the read was registered only after the mint returned. The read is now registered
  before the mint's first `await` and its cancellation is checked before the stored
  read starts. The invite `EVENT` is still emitted in that window, matching the
  capture.
- The outbound frame queue was unbounded, and its only consumer was the loop that
  performs the socket write. The queue is now bounded in bytes, a frame that does not
  fit drops and flags the overflow, the client is closed with 1013 and a reason, and
  every write the connection task performs is bounded by a write timeout so a blocked
  write cannot starve the liveness probe.

The TypeScript tree is untouched: no `src/` or `test/` file changes, so the published
package has no user-visible change. Decisions are recorded in
`docs/rewrite/decisions/0005-connection-concurrency.md`.
