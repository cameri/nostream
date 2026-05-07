---
"nostream": patch
---

Normalize runCommandWithOutput to return a CommandResult discriminated union instead of rejecting on spawn errors, fixing a crash in `info --json` when Docker is not installed.
