# nostream-website

## 1.2.0

### Minor Changes

- [#839](https://github.com/cameri/nostream/pull/839) [`91a5a7e`](https://github.com/cameri/nostream/commit/91a5a7edf9ebbb04ad749f775b5c3086192bfbc5) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - Ship the hero film in two qualities: the page serves a high-res render by default and swaps to a low variant for data-saver clients and small screens (navigator.connection.saveData / effectiveType / viewport + DPR pick). build-media.mjs now emits both variants and records both sources in hero.meta.json.

## 1.1.1

### Patch Changes

- [#835](https://github.com/cameri/nostream/pull/835) [`4642dfd`](https://github.com/cameri/nostream/commit/4642dfd00cf3b8cd60ed4d29af847a1ff6aa3c06) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - Soften the hero-film NIP-count guard to a warning while the landing film awaits its GPU re-render (NIP-77 grew the supported list to 25; the film still shows 24).

## 1.1.0

### Minor Changes

- [#828](https://github.com/cameri/nostream/pull/828) [`bb28deb`](https://github.com/cameri/nostream/commit/bb28debc5442202e3bb4e2d10ed03995d9640ded) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - feat(website): version and deploy the marketing site

  `website/site` joins the pnpm workspace as `nostream-website`, so the marketing site is versioned and released through the same changesets flow as the relay. The site builds as a static bundle (docs and changelog render from the repository at build time — no SSR) and deploys to Cloudflare Workers with static assets at ema.tnsor.network through CI.

  The deploy is a Cloudflare Worker with static assets (`website/site/wrangler.jsonc`), built and shipped by the new `Deploy Website` workflow after a release PR merges to `main`.

### Patch Changes

- [#832](https://github.com/cameri/nostream/pull/832) [`b2a997d`](https://github.com/cameri/nostream/commit/b2a997d608c031aac08237c7775f2e939d99bdd0) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - Bind ema.tnsor.network as a wrangler-declared custom domain so every deploy idempotently attaches it to the nostream-website worker.
