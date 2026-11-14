---
"nostream": minor
---

feat(peering): deliver paid peering invoices and gate peer feeds

Configured peers can request their BOLT11 invoice as a signed `kind 402` event
and pay it through Relay B's existing processor. Feed `REQ`, `COUNT` and NIP-77
requests are refused with a payment-required reason until a paid period is
active. Expired invoices are reissued after a cooldown, and a missed webhook is
rechecked before access is denied.
