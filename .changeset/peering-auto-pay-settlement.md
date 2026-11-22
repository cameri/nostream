---
"nostream": patch
---

fix(peering): keep wallet payments recoverable and request invoices before the feed

Subscribe to the seller's invoice stream before opening a paid feed, so a feed
rejected until payment no longer closes the connection first. Wallet submits
now report whether they settled; pending, unknown and ambiguous transport
outcomes keep their reservation and stay `PAYING` for recovery, while outgoing
LNbits expiry no longer counts as a failed payment. Each payment attempt owns
its row and may only move an invoice out of `PAYING` once, so a stale recovery
cannot refund or overwrite a newer approval.
