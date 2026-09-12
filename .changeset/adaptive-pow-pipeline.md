---
"nostream": minor
---

feat: add relay-load-aware adaptive PoW difficulty (NIP-13)

Adds `limits.event.pow` settings that scale the required proof-of-work difficulty between a
configured floor and ceiling based on the observed event rate, in place of the existing static
`minLeadingZeroBits` values. The event rate is tracked per worker process with the same EWMA shape
already used by the relay's rate limiter. Disabled by default (`limits.event.pow.enabled: false`),
so existing static PoW configuration is unaffected unless explicitly opted in.
