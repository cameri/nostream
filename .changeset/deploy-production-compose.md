---
"nostream": patch
---

deploy: add production Docker Compose stack for relay servers

Adds a minimal prod compose file, migrate image Dockerfile, and server layout docs
for deployments that pull `ghcr.io/cameri/nostream:main` instead of building on the host.
