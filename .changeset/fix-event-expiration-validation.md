---
"nostream": patch
---

fix: reject expiration timestamp 0 and millisecond-scale values, and accept safe-integer second-based timestamps up to the Postgres int4 max (2038-01-19T03:14:07Z) in getEventExpiration()
