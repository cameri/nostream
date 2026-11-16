---
"nostream": patch
---

fix(admin): serialize every settings-file writer with the settings write lock

The lock records its owner hostname and refreshes a heartbeat, so a relay in a
container no longer steals a live CLI lock just because the host PID does not
exist in its own PID namespace. On the same host the lock checks the owner's
process start time, so a reused PID is reclaimed without ever evicting a slow
writer, and async writers keep the lock until they settle.
