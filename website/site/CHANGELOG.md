# nostream-website

## 1.3.2

### Patch Changes

- [#894](https://github.com/cameri/nostream/pull/894) [`02b70cf`](https://github.com/cameri/nostream/commit/02b70cf162365ac1c22e9c61f8cfecde2dd54f8a) Thanks [@Ferryx349](https://github.com/Ferryx349)! - Refresh the operator console marketing film with an updated notifications screenshot and re-ship `admin.mp4` / `admin-poster.webp` for the home page.

- [#944](https://github.com/cameri/nostream/pull/944) [`82124b0`](https://github.com/cameri/nostream/commit/82124b02180b3c722e217ed39eb71c324ddec1a9) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - fix(ci): stop building and pushing container images outside a release

  Remove the container publish job from checks.yml so pushes to main no longer publish
  images to GHCR. Container image builds and pushes are now restricted exclusively to
  release.yml on published releases. Update deployment documentation and reference compose
  stacks to target the released image tag (:latest) instead of :main.

- [#916](https://github.com/cameri/nostream/pull/916) [`c40e570`](https://github.com/cameri/nostream/commit/c40e5704f6f63a86515de6bb8d4e243eb68fd830) Thanks [@Ferryx349](https://github.com/Ferryx349)! - Add Abhay Pandey Nostr profile link on the community page.

## 1.3.1

### Patch Changes

- [#899](https://github.com/cameri/nostream/pull/899) [`3ed70e4`](https://github.com/cameri/nostream/commit/3ed70e4233b210cdb382af55522933d0932d30b5) Thanks [@Ferryx349](https://github.com/Ferryx349)! - Prevent the home hero headline from overlapping the hero film on wide viewports by slightly reducing headline and film scale and reserving space above the frame.

- [#896](https://github.com/cameri/nostream/pull/896) [`bb69376`](https://github.com/cameri/nostream/commit/bb69376a475a184013ade51dfca825c31019254f) Thanks [@Priyanshubhartistm](https://github.com/Priyanshubhartistm)! - Add the official Nostream Telegram channel and development chat to the community page, and a Telegram link to the footer.

## 1.3.0

### Minor Changes

- [#884](https://github.com/cameri/nostream/pull/884) [`e654852`](https://github.com/cameri/nostream/commit/e65485297bf4d9a20ccf8f78a4aae638a22655e1) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - Add a social preview card generated from source.

  `website/site/scripts/build-social-card.mjs` renders one composition at two sizes:
  `public/media/social-card.png` (1200×630, the site's `og:image`) and
  `public/media/github-social-preview.png` (1280×640, the GitHub repository preview).
  `Base.astro` now emits the full preview set — `og:image:width`, `og:image:height`,
  `og:image:alt`, `twitter:image`, `twitter:title`, `twitter:description`,
  `og:site_name`, `og:locale` — and takes an `ogImage` prop that defaults to the card;
  `hero-poster.webp` stays the film's poster.

  The GitHub preview is uploaded by hand: **Settings → Social preview** in the
  repository, which no workflow can set.

### Patch Changes

- [#882](https://github.com/cameri/nostream/pull/882) [`9146fd3`](https://github.com/cameri/nostream/commit/9146fd311cf88fe36818eae3d29c809c99c634fb) Thanks [@Ferryx349](https://github.com/Ferryx349)! - Replace the home page admin screenshot gallery with an operator console film (explain beats on the hero backdrop, full-frame UI shots) and a pause control; add Framefields sources and ship `admin.mp4` in site media.

- [#889](https://github.com/cameri/nostream/pull/889) [`eb68475`](https://github.com/cameri/nostream/commit/eb68475eb324f319f23f64670d331faa3f684c83) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - The site now lives at **https://nostream.dev**, and every other host redirects to it over https.

  The router worker answers on `nostream.dev` and `www.nostream.dev` as well as the preview
  domain, and `CANONICAL_HOST` decides which one serves content: any other host the routes
  catch — `www`, or `ema.tnsor.network` for a non-preview path — gets a `301` to the canonical
  host, and `http` gets a `301` to the same URL over `https`. One origin serving means one
  canonical URL, so `www` and the apex cannot split search ranking by both answering `200`.

  Previews deliberately stay on `ema.tnsor.network/preview/<n>/`: that is why the domain
  remains bound. A preview build must never sit on the production domain, and a preview's own
  `SITE_URL` stays the preview origin so its absolute links and canonical tags cannot claim
  `nostream.dev`.

  The domain is an input now, not a constant: `SITE_URL` for the build, `CANONICAL_HOST` for
  the worker, both set in `deploy-website.yml`. Moving again is two lines rather than a search
  through the source, the social card and the README.

  **Cloudflare-side setup this needs before it takes effect**: the `nostream.dev` zone must
  exist, and both `nostream.dev` and `www.nostream.dev` resolve through the worker's
  declared custom domains on the next deploy. Turning on the zone's _Always Use HTTPS_
  setting makes the upgrade happen at the edge, before the worker; the worker's own `301`
  covers the case where that setting is off.

- [#888](https://github.com/cameri/nostream/pull/888) [`07dc215`](https://github.com/cameri/nostream/commit/07dc2153d1d18e1641c8f0a079c542ab8187bcdc) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - A pull request's site preview now deploys even when the comment cannot be
  written, and the CDN cache is purged after a deploy so a fresh preview is not
  served the previous build.

  **A comment can no longer prevent a deploy.** The preview workflow's comment
  steps ran before the deploy, so a pull request opened from a fork — whose
  `GITHUB_TOKEN` is read-only whatever the `permissions:` block grants — failed at
  `GraphQL: Resource not accessible by integration (addComment)` and skipped the
  deploy entirely ([run 39134047965](https://github.com/cameri/nostream/actions/runs/39134047965)).
  The deploy now runs first, every comment step is `continue-on-error`, and the
  job grants `issues: write` (PR conversation comments are issue comments;
  `pull-requests: write` alone does not cover them).

  **The cache is purged after deploying**, scoped to `https://ema.tnsor.network/preview/<n>/`
  via the `prefixes` purge, so a stale window cannot be served — on 2026-10-18
  `/preview/885/` returned production HTML for about three minutes after the
  build landed. The production workflow purges the whole zone after its router
  deploy. Both purges skip with a notice when `CLOUDFLARE_ZONE_ID` is not set for
  their environment, so an unconfigured environment deploys normally instead of
  failing.

- [#885](https://github.com/cameri/nostream/pull/885) [`f88a563`](https://github.com/cameri/nostream/commit/f88a5631f57b9f5a802b642688836271d4b67ec1) Thanks [@Priyanshubhartistm](https://github.com/Priyanshubhartistm)! - Add maintainer bio and social links on the community page for Priyanshu Bharti.

## 1.2.5

### Patch Changes

- [#858](https://github.com/cameri/nostream/pull/858) [`a0915b8`](https://github.com/cameri/nostream/commit/a0915b8c8b63d4a9b821d47b8bac9c88b1eb22b5) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - The nostream mark is now the site's pink (#ff2e88) instead of purple: logo asset recolored, favicon and apple-touch-icon regenerated, hero film's brand mark re-rendered.

## 1.2.4

### Patch Changes

- [#837](https://github.com/cameri/nostream/pull/837) [`ee7e06b`](https://github.com/cameri/nostream/commit/ee7e06b72284f07aacfd427128e99eefaab9cf84) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - Website deploy workflow fix: the deploy queue is job-scoped so relay releases can't displace a pending website deploy (measured: the nostream@3.5.1 release run was cancelled with zero jobs at the workflow-level concurrency group, before its job-level `if` could skip it). The checkout stays on the triggering `nostream-website@` tag, which the `website` environment's branch policy admits — the deployed build is exactly the released commit.

## 1.2.3

### Patch Changes

- [#845](https://github.com/cameri/nostream/pull/845) [`2234a25`](https://github.com/cameri/nostream/commit/2234a25ad8e82401f7e48946317e29939954c52e) Thanks [@chappie-daemon](https://github.com/chappie-daemon)! - Info-tip bubbles no longer clip at the viewport edge: the tooltip is centered on its (i) toggle, so near an edge it overflowed. On open (hover, tap or keyboard) the bubble now shifts horizontally to stay inside the viewport, and re-clamps on resize.

  Tooltip behavior is delegated at the document level, so every tip is covered even when its per-element listeners would have silently failed to attach.

  Site polish from an external review: the community participate cards have their own section heading, the hero headline is real DOM text with a pause control on the film, the console screenshots are labeled as real first-run console data, the honest-advertising copy matches what its warning shows, the nav's active-path comparison strips the deploy base, the get-started phase list explains the skipped numbers, and single-column grids no longer let nowrap content push the page wider than a phone viewport. The hero film is re-rendered at 1080p for the current 25-NIP list.

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
