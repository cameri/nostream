---
---

fix(payments): send the NWC subscription before the request it asks about (#1099)

`NwcRelayTransport::request` published its kind-23194 request before the `REQ` that
registers the subscription for the kind-23195 reply. A reply is ephemeral, so the relay
live-forwards it only to subscriptions already registered and stores nothing: a wallet that
answered the moment it decrypted the request had its reply dropped, and the payment call
failed as a 10-second `reply timeout` rather than as an error. The two frames now go out
`REQ` first. No other behaviour changes.
