---
"nostream-website": patch
---

Preview cleanup no longer trips the deploy token's missing KV scope: wrangler delete runs with --force, skipping the dependents probe that errored after a successful delete. Preview workers are assets-only, so nothing else changes.
