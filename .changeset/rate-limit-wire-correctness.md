---
'nostream': patch
---

fix(rate-limit): send the backoff the strategy actually means, name an outage as an error, and bucket messages by type

Three defects on one wire path, from the spike in #1004.

**The EWMA backoff was a half-life, sent as a delay.** `RateLimit.period` is the decay half-life under `ewma`, so the time until a limit lifts is `period · log2(R_new / rate)`, not `period`. With `rate: 6, period: 60000`, a client four times over the limit was told to wait 60 s and needed 120 s. The Lua script now returns its score instead of a yes/no, and the limiter returns `period · log2(score / rate)`. It was only accidentally safe before: the hash carried a TTL of exactly `period`, so a quiet client's state expired anyway — an unstated coupling that would break the moment anyone lengthened the TTL to keep state warm.

**A limiter outage was announced as `rate-limited`.** A failing backend made every connected client back off for a fault on this side. It now answers `error: rate limiter unavailable` and still rejects the event; fail-closed behaviour is unchanged.

**The message bucket ignored the message type.** One bucket per client meant a `REQ` could be refused because its `EVENT`s had filled it — the wrong message throttled, and the wrong one told to back off. The bucket key now carries the type, read from a bounded prefix of the frame because the limiter runs before validation.

`IRateLimiter.hit` returns `IRateLimiterResult` (`limited`, plus `retryAfterMs` when the strategy can estimate one) so each strategy answers in its own terms; a caller with no estimate keeps sending the period.
