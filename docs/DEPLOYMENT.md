# Deployment and container publishing

The `ghcr.io/cameri/nostream` container image is published automatically by the
Release workflow (`release.yml`) whenever an official GitHub release is published.
The workflow publishes both the `latest` tag and semver tags (e.g. `v3.6.2`).

Publishing is triggered only on published releases whose tag starts with `v`:

```text
release: published (tag v*) → build-and-push-image → ghcr.io/cameri/nostream:latest and :<version>
```

CI Checks (`checks.yml`) does not build or publish container images on push to
`main` or pull requests, ensuring that published images only correspond to
released versions.

Deployment hosts can pull the released image (`latest` or a specific release tag)
as described in [`deploy/README.md`](../deploy/README.md). After the image is on the host, follow
[`docs/DEPLOY-RUNBOOK.md`](DEPLOY-RUNBOOK.md) to migrate and recreate the relay.
There is no separate manual image publishing step.
