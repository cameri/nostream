---
"nostream": minor
---

feat(peering): authenticate peer relays with NIP-42 using the relay keypair

Adds the peering identity layer: a configured `peering.peers` trust list keyed
by relay pubkey (hex or `npub`), outbound NIP-42 AUTH signed with the relay's own
keypair, and inbound recognition of a verified peer pubkey on the connection
state. Peer status is tied to the NIP-42 session, so it expires or clears with
the socket; a valid AUTH from an unconfigured pubkey stays an ordinary client.

`peering.peers[].relayUrl` is the outbound address only — identity is always the
verified pubkey, never the URL. Relay key storage and the AUTH exchange are
documented in `docs/PEERING.md`, and the new fields are validated with the rest
of the settings document.
