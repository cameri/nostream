---
---

test(relay): signal invite mint await instead of yield polling (#991)

`a_close_during_the_invite_mint_leaves_the_event_but_not_the_read` awaits a
notification from `InMemoryInviteCodeRepository` when the mint task starts rather
than sampling `creates_started()` across a 100-iteration `yield_now()` loop,
removing the failure mode where a loaded runner exhausts the loop and fails with
a message that accuses the mint. The test also documents why it authenticates
before subscribing (NIP-42 identity requirement) and records why the wire route
was abandoned for this assertion (after #978, `CLOSE` is a connection-loop prefix).
