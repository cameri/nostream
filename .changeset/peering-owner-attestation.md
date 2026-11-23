---
"nostream": minor
---

feat(peering): add owner-attested peering requests

Peers can present a one-time, owner-signed request over their authenticated
NIP-42 connection. The receiving relay verifies the owner signature, the AUTH
relay key, the requested scopes, the current terms snapshot and NIP-13
proof-of-work, stores the accepted attestation, and returns a relay-signed
acceptance. Operators choose `required`, `preferred` or `waived`; configured
peers keep working without proof-of-work by default. `nostream peering request`
produces and sends the request using an owner key supplied outside settings.
Operational traffic never requires the owner's key.
