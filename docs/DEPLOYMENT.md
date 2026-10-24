# Deployment and container publishing

The `ghcr.io/cameri/nostream` container image is published automatically by the
Release workflow (`release.yml`) whenever an official GitHub release is published.
For release `nostream@3.6.2` the workflow publishes three tags: `latest`, the release tag itself
(`nostream@3.6.2`, which is what a host pins), and the bare version (`3.6.2`).

Publishing is triggered only on published relay releases — the changesets tag `nostream@X.Y.Z`, or the
`vX.Y.Z` form used before the changesets migration. A `nostream-website@X.Y.Z` release publishes no
image:

```text
release: published (nostream@X.Y.Z)
  → build-and-push-image
  → ghcr.io/cameri/nostream:{nostream@X.Y.Z, X.Y.Z, latest}
```

CI Checks (`checks.yml`) does not build or publish container images on push to
`main` or pull requests, ensuring that published images only correspond to
released versions.

Deployment hosts can pull the released image (`latest` or a specific release tag)
as described in [`deploy/README.md`](../deploy/README.md). After the image is on the host, follow
[`docs/DEPLOY-RUNBOOK.md`](DEPLOY-RUNBOOK.md) to migrate and recreate the relay.
There is no separate manual image publishing step.
