---
"nostream": minor
---

feat: add a Web of Trust graph service that tracks NIP-02 follow distance from an operator-configured seed pubkey

Adds a `WotGraphService` that builds a trust graph rooted at `wot.seedPubkey`, updated in real
time as kind-3 contact list events are ingested, with configurable depth (`wot.maxDepth`) and a
minimum-followers threshold for 2+ hop trust (`wot.minimumFollowers`). Exposes `getDistance()` and
`isTrusted()` for other parts of the relay to query. Disabled by default (`wot.enabled: false`).
