---
"nostream-website": minor
---

feat(website): version and deploy the marketing site

`website/site` joins the pnpm workspace as `nostream-website`, so the marketing site is versioned and released through the same changesets flow as the relay. The site builds as a static bundle (docs and changelog render from the repository at build time — no SSR) and deploys to Cloudflare Workers with static assets at ema.tnsor.network through CI.

The deploy is a Cloudflare Worker with static assets (`website/site/wrangler.jsonc`), built and shipped by the new `Deploy Website` workflow after a release PR merges to `main`.
