---
---

fix(relay): order the CLOSE-during-mint test's release by program order (#963)

`a_close_during_the_invite_mint_leaves_the_event_but_not_the_read` no longer orders
its gate release against the `CLOSE` with a 50 ms sleep. It owns its socket state and
drives `subscribe::begin` and the synchronous `unsubscribe::handle` directly, so the
abort is a program-order predecessor of the release. No production code changes.
