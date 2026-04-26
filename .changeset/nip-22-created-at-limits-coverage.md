---
"nostream": patch
---

Improve NIP-22 `created_at` limit handling coverage and boundary reliability.

This adds integration coverage for accepted and rejected events across configured positive and negative `created_at` deltas, and keeps rejection semantics consistent (`rejected`) for out-of-range timestamps.
