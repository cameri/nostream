---
"nostream": patch
---

fix(compose): keep dynamic container addresses off the static ones

`docker-compose.yml` pins `nostream`, `nostream-db` and `nostream-cache` to `10.10.10.2`–`.4`, but dynamic allocation drew from the bottom of the same `/24`. The observability stack has no dependency that orders it after `nostream`, so `otel-collector` could be given `.2` and `nostream` then failed to start with `Address already in use` — most reliably after a host reboot, when the daemon starts containers in arbitrary order.

Dynamic allocation is now confined to `10.10.10.128/26`. The subnet and gateway are unchanged, so `10.10.10.1` stays the trusted proxy, and the overlay pins (`.5`, `.252`, `.253`) stay outside the pool.
