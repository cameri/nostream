---
"nostream": minor
---

feat(nip43): issue kind 28935 invite codes on request

NIP-43 kind 28935 is not an event clients publish — it is a REQ the relay answers by
minting an invite code on the fly and returning a relay-signed ephemeral event. Nostream
now serves those subscriptions, completing the membership flow: request a claim, join with
kind 28934, publish.

Off by default. It requires `nip43.enabled` and the new `nip43.allowInviteRequests`, a
NIP-42 authenticated requester, an `info.self` consistent with the relay signing key, and a
per-pubkey budget under the new `limits.invite.rateLimits` (5/hour by default). This also
makes the previously inert `nip43.inviteRequestWhitelist` setting take effect. The minted
event is never persisted and never broadcast: the claim tag is a bearer secret and is sent
only to the socket that asked for it.

Two fixes the flow depended on. The relay signs its own events with a key derived from
`SECRET`, but `info.self` was a hand-edited string that nothing validated — by default it
was a placeholder that is not a pubkey at all, so any NIP-43 client verifying a relay-signed
event against `self` would reject it. `info.self` is now optional: when unset or unparseable,
NIP-11 advertises the derived signing pubkey instead, and `nostream info` prints that pubkey
so operators can pin it.

Kind 28935 also sits in the ephemeral range, so a client-published one fell through to
`EphemeralEventStrategy` and was broadcast to every subscriber — including everyone
subscribed to kind 28935 waiting for a real invite. Anyone could inject a forged `claim` tag
into that subscription. It is now rejected with an `OK` false and never broadcast, and
bypasses the NIP-43 admission gate so that rejection actually reaches non-members, who are
the ones most likely to publish it by mistake while trying to obtain a code.

CLI.md and README.md now describe the request flow. CLI.md previously claimed the relay
"does not yet generate kind 28935 on `REQ`", and never mentioned that `nostream info`
prints the signing pubkey that CONFIGURATION.md tells operators to pin.
