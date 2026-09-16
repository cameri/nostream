---
"nostream": patch
---

fix: return COUNT results for filters with generic tag queries (`#e`, `#p`, `#g`, `#h`), which projected `event_id` twice and failed with "error: unable to count events"
