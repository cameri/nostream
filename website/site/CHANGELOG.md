# nostream-website

## 1.2.2

### Patch Changes

- [#844](https://github.com/cameri/nostream/pull/844) [`c352d72`](https://github.com/cameri/nostream/commit/c352d72249ad44176379a1c15c97115a68828d4e) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - Preview cleanup no longer trips the deploy token's missing KV scope: wrangler delete runs with --force, skipping the dependents probe that errored after a successful delete. Preview workers are assets-only, so nothing else changes.

- [#847](https://github.com/cameri/nostream/pull/847) [`1b1ef4f`](https://github.com/cameri/nostream/commit/1b1ef4f8bce745f170a5eb432944a85729ee9de9) Thanks [@Ferryx349](https://github.com/Ferryx349)! - Add maintainer bio, social links, and updated profile photo on the community page for Abhay Pandey.

## 1.2.1

### Patch Changes

- [#842](https://github.com/cameri/nostream/pull/842) [`72fca58`](https://github.com/cameri/nostream/commit/72fca5893b8b8f7daede8ad9841f124fe5278f53) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - Add PR preview deployments: site changes are previewable at ema.tnsor.network/preview/<PR>/ and cleaned up on close. Requires the website-preview environment (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) to activate.

- [#842](https://github.com/cameri/nostream/pull/842) [`72fca58`](https://github.com/cameri/nostream/commit/72fca5893b8b8f7daede8ad9841f124fe5278f53) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - Website copy now leads with what each feature does for the user; the technical detail (NIP numbers, protocol names, command flags) moved into (i) info tooltips on hover, focus or tap.

  Also ships PR previews: every PR touching the site builds under `/preview/<n>/` and deploys its own worker (`nostream-web-pr-<n>`); the production router worker (new) proxies `ema.tnsor.network/preview/<n>/*` to it, so the preview URL stays on the production domain. Previews are deleted when the PR closes. The production deploy switches from the assets-only worker to the router on the next release — same assets, same domain, plus the preview route.

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
