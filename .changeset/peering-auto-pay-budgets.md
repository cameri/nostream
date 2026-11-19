---
"nostream": minor
---

feat(peering): decide and pay peer invoices within budgets

Adds the buying-side policy: verify a peer invoice against its advertised
NIP-11 term, dedupe on the payment hash, reserve per-peer/global budget
atomically, pay through the configured wallet, and hold anything outside the
envelope for operator approval.
