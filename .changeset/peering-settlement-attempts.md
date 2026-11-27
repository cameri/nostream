---
"nostream": patch
---

fix(peering): count failed invoice settlements and alert once

A paid peering invoice whose settlement rolls back is now retried with a
persisted attempt counter and last error. After
`peering.settlementFailureThreshold` failures (default 5), one
`peering.payment.failed` notification is enqueued for the operator, and the
invoice stays in the retry set. Duplicate callbacks and underpayments are not
counted. A completed-but-unconfirmed invoice is no longer downgraded when the
processor later reports another status, so it stays retryable.
