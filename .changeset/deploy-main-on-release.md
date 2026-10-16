---
"nostream-website": patch
---

Website deploy workflow fix: the deploy queue is job-scoped so relay releases can't displace a pending website deploy (measured: the nostream@3.5.1 release run was cancelled with zero jobs at the workflow-level concurrency group, before its job-level `if` could skip it). The checkout stays on the triggering `nostream-website@` tag, which the `website` environment's branch policy admits — the deployed build is exactly the released commit.
