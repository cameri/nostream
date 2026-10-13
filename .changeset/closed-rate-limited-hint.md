---
"nostream": minor
---

feat(nip-01): send the `rate-limited` backoff hint on CLOSED

When the per-IP message rate limit trips on a `REQ` or `COUNT`, the relay now replies `["CLOSED", <id>, "rate-limited: slow down", "<ms>"]` with the tripped window's period as the backoff, instead of a `NOTICE`. Other message types keep the existing `NOTICE`.
