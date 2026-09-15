---
"nostream": minor
---

feat(deploy): add HAProxy blue/green compose stack

Two relays behind HAProxy with `/readyz` health checks and `option redispatch`, plus a rolling recreate script that replaces one relay at a time for zero-downtime image updates.
