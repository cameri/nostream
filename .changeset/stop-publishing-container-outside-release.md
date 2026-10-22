---
"nostream": patch
"nostream-website": patch
---

fix(ci): stop building and pushing container images outside a release

Remove the container publish job from checks.yml so pushes to main no longer publish
images to GHCR. Container image builds and pushes are now restricted exclusively to
release.yml on published releases. Update deployment documentation and reference compose
stacks to target the released image tag (:latest) instead of :main.
