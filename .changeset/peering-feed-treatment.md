---
"nostream": minor
---

feat(peering): treat authenticated peers as feeds, not clients

Adds `limits.peer`, a separate limit set for connections that have proven a
configured `peering.peers` pubkey with NIP-42 AUTH. Peer subscriptions use
`limits.peer.subscription` instead of `limits.client.subscription`, and peer
messages use `limits.peer.message` in a separate rate-limit bucket, so a
full-feed subscription cannot trip the client EWMA limiter or the client
`max_subscriptions` cap.

Peers are eligible for full feeds by default: `maxLimit` is uncapped and the
subscription caps are higher. A high but finite peer message rate keeps the
credential from becoming an unbounded egress path. Unauthenticated or
unconfigured connections keep the existing client limits exactly as before.
The new limits are validated with the rest of the settings document and
documented in `CONFIGURATION.md` and `docs/PEERING.md`.
