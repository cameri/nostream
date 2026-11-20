---
"nostream": minor
---

feat(peering): enforce buyer budgets before paying peer invoices

Adds the buying-side policy: verify a peer invoice against its advertised
NIP-11 term, dedupe on the payment hash, reserve per-peer and global budget
counters atomically, pay through the configured wallet, and hold anything
outside the envelope for operator approval.
