---
"nostream": patch
---

fix(peering): retry serialization conflicts in invoice settlement

A serializable peering settlement that loses a concurrent race now retries the
whole confirmation transaction up to three times. Deterministic failures
(missing peer, missing term snapshot) and underpayments are not retried.
