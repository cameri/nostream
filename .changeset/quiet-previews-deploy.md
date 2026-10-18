---
'nostream-website': patch
---

A pull request's site preview now deploys even when the comment cannot be
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
