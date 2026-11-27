---
"nostream": patch
---

fix(peering): keep unconfirmed settlements in the retry set

A processor report that downgrades a completed peering invoice with
`confirmed_at` still null no longer overwrites the stored `COMPLETED` status.
The invoice remains in the settlement retry set until the period is committed.
