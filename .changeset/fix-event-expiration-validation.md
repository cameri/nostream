---
"nostream": patch
---

fix: reject expiration timestamp 0 and millisecond-scale values, and accept safe-integer second-based timestamps up to year 9999 in getEventExpiration()
