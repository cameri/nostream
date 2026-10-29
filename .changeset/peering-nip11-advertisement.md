---
"nostream": minor
---

feat(peering): advertise peering terms and scopes in NIP-11

The relay information document now carries a `peering` section built from the new
`peering` settings block. It advertises whether peering is offered, the feeds
available as `kinds` scopes with an absolute `since`/`until` range or a rolling
`windowSeconds`, terms in the existing NIP-11 fee-object shape (`amount`, `unit`,
`period`) where an empty `terms` list means settlement-free, a peer `contact` or
WebSocket `endpoint`, and `min_pow_difficulty` — the NIP-13 work a peering request
must carry, `0` meaning none.

Disabled peering publishes only `{ "enabled": false }`, so half-configured terms are
never read as an accepted peer: this is the discovery surface other relays read
before connecting, not a peer-acceptance path. Settings validation rejects invalid
scopes, terms, time ranges, endpoints and proof-of-work bounds with a clear path, and
all `peering.*` fields are documented in `CONFIGURATION.md` with an example document.

Closes #932.
