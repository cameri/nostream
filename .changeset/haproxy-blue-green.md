---
"nostream": minor
---

feat(deploy): add HAProxy blue/green compose stack

Two relays behind HAProxy with `/readyz` health checks and `option redispatch`, plus a rolling recreate script that replaces one relay at a time for zero-downtime image updates. Optional Redis stream fan-out (`RELAY_BROADCAST_FANOUT`) lets both relays share live WebSocket broadcasts while workers keep using cluster `process.send`.
