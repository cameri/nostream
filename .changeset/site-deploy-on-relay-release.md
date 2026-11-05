---
---

fix(ci): redeploy the site when a relay release publishes

No published package changes: this touches `.github/workflows/deploy-website.yml`
only, and the site is redeployed rather than reversioned.

The site's version badge and changelog page are read from the repo at build
time, so both went stale between site releases: on 2026-11-05 nostream.dev
still served `v3.9.0` six relay releases later. A relay release now starts the
deploy through the `Release` workflow's completion, which runs on `main` — the
only ref the `website` environment admits for that purpose.
