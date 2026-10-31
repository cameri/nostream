---
"nostream": patch
---

ci(deploy): retry the website deploy on a transient Cloudflare failure

Run 40103130697 failed at `Deploy the preview worker` with Cloudflare API error
`code: 10013` after a build that had already succeeded, and the next push deployed
the same commit successfully — a transient upstream failure, not a defect in the
site or the workflow.

Both website deploys now run through `.github/scripts/deploy-with-retry.sh`, which
wraps the deploy step (not the build) in three attempts with a 10 s then 30 s
backoff, a per-attempt timeout, and a step-level `timeout-minutes`. It retries only
`code: 10013`, an HTTP 5xx, a connection reset and an expired attempt timeout; an
authentication failure, a missing environment or a wrangler validation error still
fails on the first attempt. Every retry emits a `::warning::` naming the attempt and
the reason, so the flake rate stays visible instead of disappearing behind a
passing job.
