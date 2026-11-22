---
"nostream": patch
---

fix(peering): keep wallet payments recoverable and request invoices before the feed

Subscribe to the seller's invoice stream before opening a paid feed, so a feed
rejected until payment no longer closes the connection first. Wallet submits
now report whether they settled; pending and unknown outcomes keep their
reservation and stay `PAYING` for recovery. Each payment attempt owns its row,
so a stale recovery cannot refund or overwrite a newer approval.
