---
---

fix(relay): order the CLOSE-during-mint test's release by program order (#963)

`a_close_during_the_invite_mint_leaves_the_event_but_not_the_read` no longer orders
its gate release against the `CLOSE` with a 50 ms sleep. It owns a `Connection` and a
`FrameSink` rather than a socket, and drives `subscribe::begin` — whose prefix registers
the subscription and its read on the test's own task — plus the synchronous
`unsubscribe::handle`, so the abort is a program-order predecessor of the release. No
production code changes.
