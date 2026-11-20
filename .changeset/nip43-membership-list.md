---
'nostream': minor
---

feat(nip43): publish the kind 13534 membership list

With the new `nip43.publishMembershipList` setting (off by default) the relay publishes a replaceable kind 13534 event, signed by its own key, with the NIP-70 `-` tag and one `member` tag per admitted pubkey, and refreshes it after every successful join or leave. Joins and leaves that are rejected or change nothing do not refresh it. Nothing is published when `info.self` does not match the relay's signing pubkey, since NIP-43 requires that signer. The list makes every member's pubkey public to anyone who can read the relay, which is why the setting defaults to off. It is a convenience for clients, not the source of truth for who may publish, and it holds at most the first 10,000 members. Users who asked to vanish are left out. Admissions made another way, for example a paid admission, do not refresh it.
