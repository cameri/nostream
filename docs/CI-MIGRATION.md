# CI container publishing migration

Container publishing is now restricted exclusively to official releases via `.github/workflows/release.yml`.

## What changed

The `publish-container-image` job was removed from `.github/workflows/checks.yml`. Container images
are no longer built or published on pushes to `main`.

## Why

Publishing images from unreleased commits on `main` caused the `main` tag (and per-commit SHA tags)
to serve as moving targets of unreleased code, creating drift between published releases and images
pulled in production. Publishing is now aligned strictly with official GitHub releases.

## New behavior

Container images are published only by `.github/workflows/release.yml` when an official relay release
is published. Changesets tags a relay release `nostream@X.Y.Z`, so that prefix is what the workflow
matches; the `vX.Y.Z` form from before the changesets migration is still accepted. Pushes to `main` and pull requests run verification checks without
publishing any container images.

## Action required

Deployments tracking `ghcr.io/cameri/nostream:main` should be updated to track released versions,
such as `ghcr.io/cameri/nostream:latest` or pinned release tags (e.g. `ghcr.io/cameri/nostream:nostream@3.6.2`,
published as-is from the release tag, or the bare `ghcr.io/cameri/nostream:3.6.2`).
See [`deploy/README.md`](../deploy/README.md) and [`docs/DEPLOY-RUNBOOK.md`](DEPLOY-RUNBOOK.md).
