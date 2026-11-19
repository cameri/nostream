---
'nostream': patch
---

fix(nip05): a replaced kind-0 profile no longer changes the author's NIP-05 verification

A relay accepts an older kind-0 profile for an author who has already published a newer one (the replace is a no-op and the client is answered `duplicate:`), but the NIP-05 handling ran for it anyway. Anyone could take a public, validly signed older profile of an author, one without a `nip05` field or with another identifier, and publish it again to delete the author's current verification, or replace it with the older identifier, which with NIP-05 mode `enabled` blocked the author from publishing. The NIP-05 handling now runs only for a profile that is the author's current one (the later `created_at`, and the lower id on a tie, which is the one the replaceable upsert keeps). The stored profile is read the way the upsert sees it, so a current profile that subscriptions hide (a NIP-56 reported or a deleted one) still counts. If the check itself fails the profile is processed as before.
