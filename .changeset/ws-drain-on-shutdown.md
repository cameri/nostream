---
"nostream": minor
---

feat(shutdown): drain WebSocket clients on SIGTERM

On SIGTERM, `/readyz` returns 503, new WebSocket connections are rejected, and existing clients receive Nostr CLOSED messages before the socket closes. Drain is bounded by `WS_DRAIN_TIMEOUT_MS` (default 30s).
