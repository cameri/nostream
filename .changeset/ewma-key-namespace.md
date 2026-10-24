---
"nostream": patch
---

Namespace EWMA rate-limiter keys so they cannot collide with sliding-window keys

The two strategies store different Redis types under the same key name: a sliding
window keeps a sorted set, EWMA keeps a hash. A cache volume carried over from 2.x,
or an operator switching `limits.rateLimiter.strategy`, therefore left EWMA reading a
sorted set as a hash — a `WRONGTYPE` error on every connection and message until the
old key expired. EWMA now writes under an `ewma:` prefix, which also keeps both
strategies' windows intact if the strategy is switched back.
