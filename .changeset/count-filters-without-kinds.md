---
'nostream': patch
---

fix(nip42): require auth to COUNT a filter that names no kinds when restricted reads are on

With `nip42.restrictedReads` enabled, a COUNT filter that named a restricted kind (4, 1059, ...) had to be scoped to the client's own pubkeys, but a filter that named no kinds was not checked, and the count still included the restricted events. An unauthenticated client could count, for example, `{"#p": [pubkey]}` and learn how many private messages a pubkey had received. A COUNT filter without `kinds` is now treated like one that names a restricted kind, the same rule NIP-77 reconciliation already follows: it must be scoped with `authors` or `#p` to the authenticated client's own pubkeys. Relays that do not enable `nip42.restrictedReads` are not affected.
