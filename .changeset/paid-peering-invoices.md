---
"nostream": minor
---

feat(peering): sell paid peering access with Lightning invoices

Configured peers with paid `peering.terms` can now request a BOLT11 invoice,
receive it as a signed `kind 402` event, and activate feed access for the paid
period. Settlement uses the existing payment processor callbacks plus polling,
renewal invoices are issued before the period ends, and an unpaid period lapses
the feed without deleting stored events or sync state. Billing state is exposed
through `GET /admin/peering`.
