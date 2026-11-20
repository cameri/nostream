---
"nostream": minor
---

feat(peering): add the buyer invoice ledger and budget primitives

Adds the storage and decoding foundation for buying peering: a
`peering_invoices` ledger deduped by BOLT11 payment hash, per-peer/global
`peering_budgets` counters, a narrow BOLT11 decoder, and the buyer settings
contracts. Automatic payment and admin approval ship in the follow-up slices.
