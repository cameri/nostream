---
"nostream": minor
---

feat(peering): rate-limit on-demand requests from authenticated peers

Authenticated peers can request events outside their standing feed with a
normal `REQ`, `COUNT`, or ad-hoc `NEG-OPEN` session. Those requests continue to
use peer subscription and NIP-77 limits instead of client limits, and are now
bounded per peer pubkey by `limits.peer.request.rateLimits` (default 300
requests/minute across `REQ`, `COUNT`, and `NEG-OPEN`).

Refused `REQ`/`COUNT` calls receive `CLOSED` with a `rate-limited:` reason and
retry hint; refused `NEG-OPEN` sessions receive `NEG-ERR`. The limiter fails
closed when its store is unavailable, and unidentified clients are unaffected.
Per-peer request/event accounting and admin-console visibility are left to the
dedicated admin-console follow-up.
