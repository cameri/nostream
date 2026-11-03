---
"nostream": minor
---

feat(peering): sync configured peers over NIP-77 and a live feed

Adds an outbound peering-sync worker. For every enabled `peering.peers`
entry it reads the peer's NIP-11 `peering.scopes`, authenticates with NIP-42
using the relay's own keypair, reconciles each scope over NIP-77 negentropy,
fetches only the missing ids, and keeps a live subscription for the same
scopes. Periodic reconciliation and reconnect-and-resync close gaps the live
feed can miss, and a new or restarted peer converges without a full dump.

Fetched and live events are accepted only when they match the agreed scope,
were requested by id, and pass id/signature verification. They are applied with
the same kind rules as local writes (addressable `d`-tag keys, kind-5 deletes,
kind-62 vanishes, ephemeral broadcast-only), and authors under an active vanish
request are skipped. Live events are broadcast to local subscribers; backfill is
not, so a full sync does not fan out a dump. Oversized scopes are split into
time ranges, and fetch/live buffers are bounded by count and bytes. Per-peer sync
state (status, last reconciliation, lag, missing count) is recorded in Redis,
exposed at `GET /admin/peering`, shown in the admin console's Operations view,
and included in diagnostics exports.
