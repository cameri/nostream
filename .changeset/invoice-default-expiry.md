---
"nostream": patch
---

fix(payments): stop stale invoices from wedging payment polling

A relay could stop clearing payments entirely, needing `delete from invoices` to
recover. Two things combined to cause it.

Invoices created without an expiry could never be retired, because the expiry
check treats a missing date as "not expired", so the maintenance worker left them
pending forever. The LNURL processor set no expiry on any invoice, making this
certain there rather than incidental. Invoices now fall back to
`payments.invoiceExpirySeconds` when the processor reports no expiry of its own,
and existing pending rows without one are backfilled.

Separately, each maintenance pass re-read the same oldest page of pending
invoices, so one page of invoices that never resolve starved every newer one
indefinitely. The worker now advances through the queue and wraps at the end,
keeping the same per-pass cost while guaranteeing every pending invoice is
eventually polled.
