---
"nostream": minor
---

feat(storage): add an `eventStore.backend` setting and build every event repository through one factory

Defaults to `postgres`, the only backend for now. The backend is read once at startup and passed to every worker.
