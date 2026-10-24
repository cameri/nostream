---
"nostream": minor
---

chore: sunset the StaticMirroringWorker

The static mirroring worker is removed, together with the `mirroring.static` settings and the mirror health table and `/admin/ops/mirrors` route of the admin console. A `mirroring.static` that is still configured is ignored and logs a warning at start-up. To sync events with another relay, use NIP-77 (Negentropy), for example with `strfry sync`.
