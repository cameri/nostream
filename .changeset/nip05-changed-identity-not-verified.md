---
'nostream': patch
---

fix(nip05): a changed NIP-05 identifier does not inherit the earlier verification

When an author published a kind-0 profile with a different `nip05` and the lookup failed with a transient error (a timeout, a 5xx), the new identifier and domain were saved with the previous identifier's `isVerified` and `lastVerifiedAt`. With NIP-05 mode `enabled` that treated the new domain as verified, so an author could keep publishing under a domain the relay's allow or block list now rejected, or under an identifier they had not proven, without ever passing a lookup. The earlier verification is now kept after a transient error only when the identifier and domain are the same (ignoring letter case); a changed identifier starts unverified until a lookup succeeds.
