---
"nostream": patch
---

feat(ops): add /readyz readiness probe for Postgres and Redis

Adds a public readiness endpoint for zero-downtime deploy workflows. HAProxy (or similar) can use `/readyz` to confirm an instance can serve traffic before cutover, while `/healthz` remains a lightweight liveness check.
