---
"nostream": patch
---

ci: disable CodeQL workflow

Removes the CodeQL Advanced GitHub Actions workflow, custom query pack, config,
and route suppression comments to stop false-positive security alerts on admin
routes that already use custom auth and rate limiting.
