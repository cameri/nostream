---
"nostream": patch
"nostream-website": patch
---

ci(release): allow the image build to be dispatched for an existing tag

A published release is immutable, so when the image build fails while publishing
it, the release cannot be re-published to retry: GitHub refuses the round trip
with `immutable cannot be changed when release is immutable`. That left #964's
release with no image and no way to build one.

`release.yml` now accepts `workflow_dispatch` with a `tag` input, and refuses a
tag that is not a relay release, since the event carries no tag of its own. With
no release flags present the prerelease is read from the version, so a dispatch
of `nostream@3.8.0-rc.1` still leaves `latest` where it is.
