---
"nostream": patch
---

build: pin the node base image in every file that names one

`Dockerfile` pinned `node:24.22.1-alpine` by digest, but `Dockerfile.railwayapp`, `Dockerfile.test`, `docker-compose.yml` and `test/integration/docker-compose.yml` still said `node:24-alpine`. The relay image, the CI image, the Railway image and both migration containers could each start from a different base, and a floating tag moves under a release — so the same commit built twice could run different node code without a change saying so.

All five now carry the same tag and digest, and a unit test holds them there: it fails if any reference loses its digest, and it fails if two different references appear.
