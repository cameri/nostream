---
"nostream": patch
---

test(redis): prove the relay keeps publishing after the cache loses its scripts

Nothing is shipped in this change — it is coverage for #1002. The relay issues `EVALSHA`, and Lua scripts live in the cache's memory, so a Redis restart leaves every script call answering `NOSCRIPT`. The adapter's retry for that was added in #920 and had only a stubbed unit test: `evalSha` was mocked, which cannot catch a retry that stops working through the workers that actually call it.

The new integration scenario publishes, runs `SCRIPT FLUSH` against the same Redis, then publishes twice more. `SCRIPT FLUSH` is the whole of a restart as far as the relay can tell, and it is deterministic — no container to restart and no reconnect to wait for. The scenario configures a message rate limit on purpose, because both limiters return early on an empty list and a scenario without one would pass whether or not the fallback existed.
