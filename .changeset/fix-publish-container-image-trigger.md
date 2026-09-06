---
"nostream": patch
---

fix(ci): publish container image after CI passes on main

Removes the standalone publish workflow and its unsafe workflow_run trigger.
Image publish now runs as the final job in checks.yml on pushes to main, after
lint, build, and tests succeed.
