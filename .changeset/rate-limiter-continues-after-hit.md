---
"nostream": patch
---

fix: stop checking additional rate limit windows once a client is already rate-limited

`isRateLimited()` in `EventMessageHandler` and `WebSocketAdapter` looped through every
configured rate limit window even after one had already tripped, calling `rateLimiter.hit()`
(a Redis write) for each remaining window. Both now return as soon as the first exceeded
window is found, avoiding redundant Redis writes for clients that are already being limited.
