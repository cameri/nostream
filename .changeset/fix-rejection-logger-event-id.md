---
"nostream": patch
---

fix: include event id in expired and rate-limited rejection logs

Expired and rate-limited event rejections logged `event %s rejected: ...` without
passing `event.id`, so operators saw a literal `%s` instead of the event id.
