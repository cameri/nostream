---
"nostream": patch
---

fix(relay): handle messages sent immediately after a WebSocket opens

Attaches a temporary message listener before the awaited connection
rate-limit check, pauses the socket during admission, and buffers early
frames with bounded limits (64 messages / 1 MiB). Once admission succeeds the
adapter is created, buffered frames are replayed in arrival order, and the
socket resumes. Rate-limited connections are still terminated before any
message is processed, and buffer overflow closes with code 1009 instead of
silently dropping frames. Adds regression tests for early-message replay,
rate-limited rejection, and overflow handling.
