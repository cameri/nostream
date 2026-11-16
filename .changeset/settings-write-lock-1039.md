---
"nostream": patch
---

fix(admin): serialize every settings-file writer with the settings write lock

The lock records its owner hostname and refreshes a heartbeat, so a relay in a
container no longer steals a live CLI lock just because the host PID does not
exist in its own PID namespace.
