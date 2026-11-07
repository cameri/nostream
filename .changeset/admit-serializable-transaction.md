---
'nostream': patch
---

Admission now runs inside a serializable transaction. `admit_user()` opens with `PERFORM ASSERT_SERIALIZED()`, so calling it on the default read-committed connection raised `SN_NOT_SERIALIZABLE` and every NIP-43 join request failed. A caller that supplies its own client (the payments path) still runs inside the transaction it passes.
