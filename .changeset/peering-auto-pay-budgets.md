---
"nostream": minor
---

feat(peering): auto-pay peer invoices within per-peer and global budgets

The buying side now watches the signed kind 402 invoice stream of configured
peers, verifies the BOLT11 amount against the peer's advertised term, dedupes on
the payment hash, and pays through the configured wallet while both budgets have
room. Anything outside the envelope is held for operator approval in the admin
console, with spend and budget remaining per peer and period.
