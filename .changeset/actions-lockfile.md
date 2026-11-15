---
---

ci: lock the actions every workflow runs (#1117)

Every `uses:` was pinned to a mutable tag, so a tag moved upstream changed what CI executed and nothing recorded what a run resolved to. `gh actions-lock` now writes `.github/workflows/actions.lock` with the commit each action resolves to, keeping the readable version in the workflow, and a `lockfile` job runs `gh actions-lock --verify` so a workflow edit that is not relocked fails. `amannn/action-semantic-pull-request@v5` needed a full version before it could lock and moved to `v5.5.3`, the same major. No runtime behaviour changes; the lock stays advisory until the repository enables Workflow lockfiles.
