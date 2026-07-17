---
"nostream": patch
---

fix: await Redis EXISTS call in RedisAdapter.hasKey() so it reflects actual key presence instead of always returning true
