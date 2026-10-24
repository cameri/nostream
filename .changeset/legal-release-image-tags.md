---
"nostream": patch
"nostream-website": patch
---

fix(ci): publish legal image tags and keep `latest` off prereleases

A changesets relay release is tagged `nostream@3.7.0`, and `@` is not legal in a
Docker tag, so the `type=ref,event=tag` rule handed buildx a tag it refused: the
first live run of the Release workflow failed with `invalid tag ...: invalid
reference format` and published no image for the release (#964).

The tags are now computed by a shell step, so every tag is a value this
repository chose and can check: the bare version, `vX.Y.Z` as well beside it for
a legacy tag, and `latest` only when the release is not a prerelease. Each tag is
validated against Docker's grammar before the build, so an illegal one fails by
name at that step instead of at buildx.

`docs/CI-MIGRATION.md`, `docs/DEPLOYMENT.md` and `docs/DEPLOY-RUNBOOK.md` no
longer promise `nostream@X.Y.Z` as a pinnable image tag, and the runbook now
names the receiver change that subscribing to `release` events depends on.
