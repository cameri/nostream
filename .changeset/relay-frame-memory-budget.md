---
---

feat(relay): bound the relay's total queued frames and the sockets one address may hold

The outbound queue was bounded per socket and the number of sockets was bounded by nothing:
one address that opened sockets and stopped reading could hold 8 MiB for every socket it kept,
measured as 384 MiB from the shipped attempt limits, and nothing gave a closed socket's queued
bytes back. Two bounds now sit beside that one, both recorded in
`docs/rewrite/decisions/0008-frame-memory-budget.md`:

- `RelayConfig::frame_memory_budget_bytes` (256 MiB) is one process-wide budget every socket's
  queued payload is counted against, admitted frame by frame at the sink and refunded when a
  socket's last handle drops.
- `RelayConfig::max_connections_per_ip` (64) caps the live sockets one address may hold, as a
  gauge beside the attempt limiter rather than folded into it.

Both refuse the way the policy comment on #959 asks: an immediate `1013` close with a fixed
reason and its own counter, never a text frame and never a silent drop. See #959.

The TypeScript tree is untouched: no `src/` or `test/` file changes, so the published package
has no user-visible change.
