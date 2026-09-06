# CI container publishing migration

Container publishing is now part of `.github/workflows/checks.yml`.

## What changed

The standalone `publish-container-image.yml` workflow, which listened for a
completed `workflow_run`, was removed. `checks.yml` now contains
`publish-container-image` as its final job.

## Why

Keeping publishing in the workflow that performed the checks makes its
dependencies explicit. It avoids the timing and event-context ambiguity of a
separate `workflow_run`, which could be triggered by an external pull-request
run.

## New behavior

On successful pushes to `main`, CI runs linting, the build check, unit tests,
integration tests, and post-test reporting before publishing the container
image. The publish job cannot run for pull requests or manual workflow runs.

## Action required

None. Developers and deployment users receive the same `main` and per-commit
container image tags automatically after CI succeeds.
