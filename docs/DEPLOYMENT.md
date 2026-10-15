# Deployment and container publishing

The `ghcr.io/cameri/nostream` container image is published automatically by the
CI Checks workflow after a successful push to `main`. The workflow publishes
both the `main` tag and a `sha-<commit>` tag.

Publishing is the final stage of the CI dependency chain:

```text
changes → lint and build-check → unit and integration tests → post-tests → publish-container-image
```

The publish job runs only for `refs/heads/main` and only when `post-tests`
succeeds. Pull requests and manual workflow runs do not publish images.

Deployment hosts can pull the `main` image as described in
[`deploy/README.md`](../deploy/README.md). After the image is on the host, follow
[`docs/DEPLOY-RUNBOOK.md`](DEPLOY-RUNBOOK.md) to migrate and recreate the relay.
There is no separate manual image publishing step.
