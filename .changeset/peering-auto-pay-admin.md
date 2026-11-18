---
"nostream": minor
---

feat(peering): surface buyer invoices and budgets in the admin console

Watches the peer's signed kind 402 invoice stream over the authenticated sync
connection, pays through LNbits or NWC, and exposes held invoices with
operator approve/reject actions, budget spend/remaining, and invoice counts.
