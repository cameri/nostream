---
---

fix(dvm): keep a worker killable after it closes stdout (#1102)

`drive_worker` watched the kill request only while it was reading the child's stdout. Once stdout closed — a worker that finished its output and hung, or one whose output went elsewhere — it blocked in `process.wait()`, and a later kill (a job timeout, a stalled stdin write, shutdown) reached nothing, so the child lived until it exited on its own or the orchestrator itself was dropped. The wait now runs alongside the kill request, so the kill is delivered and the child reaped either way. Rust-only; no published package changes.
