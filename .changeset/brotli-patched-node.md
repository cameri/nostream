---
"nostream": patch
---

chore(deps): build and test on Node 24.22.1, which patches the Brotli decoder

CVE-2026-111497 is an out-of-bounds write in every Brotli decoder up to 1.2.0,
reachable by anything that decodes a `br` stream. Node bundles its own decoder,
so the fix is the Node release: 24.22.1 on the 24 line. `.nvmrc` and both
Dockerfile stages move from floating `node:24-alpine` to a pinned
`node:24.22.1-alpine`.
