---
"nostream": patch
---

docs(peering): explain the unconfirmed-settlement cursor

The maintenance worker's retry offset can skip an invoice until a short page
resets it. Document that this is a starvation guard, not an exact resume point,
and that it delays a retry without losing it.
