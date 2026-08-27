---
"nostream": patch
---

ci: build and push container image to GHCR after CI passes on main

Adds a GitHub Actions workflow that publishes `ghcr.io/cameri/nostream:main` and a
per-commit `sha-*` tag once the CI Checks workflow succeeds for pushes to `main`.
