---
"nostream": patch
---

test(relay): add non-sequential socket test suite for connection and command races

Adds deterministic real-socket test cases covering racing connection states:
- Reconnect storm with immediate REQ on the open tick across multiple concurrent sockets
- Pipelined commands in a single write buffer preserving arrival order
- REQ immediately followed by CLOSE of the same subscription ID
- EVENT sent on open tick
- Binary-framed JSON commands
- Socket resilience and valid command processing following malformed JSON
