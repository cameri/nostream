# Peering identity

Relay peering lets one relay serve feeds to another. Before any feed exists, each
side must be able to prove which relay it is: a URL is an address, not an
identity. Nostream uses NIP-42 AUTH signed with the relay's own keypair for that
proof, and a configured pubkey list for trust.

This phase covers identity only. Feed treatment, sync, on-demand requests,
payments, and the admin console build on it.

## Relay keypair

The relay already has a signing key:

- `RELAY_PRIVATE_KEY` (hex), when set, wins.
- Otherwise the key is derived from `SECRET`.
- `SECRET` and `RELAY_PRIVATE_KEY` are environment variables, documented in
  [CONFIGURATION.md](../CONFIGURATION.md#environment-variables). The private key
  is never written to `settings.yaml` and never sent to another relay.

`info.self` is optional. When set, it is the pubkey advertised as `self` in the
NIP-11 document and must match the key the relay actually signs with. When unset
or unparseable, NIP-11 advertises the derived signing pubkey instead. Run:

```bash
nostream info
```

to print the relay's derived `self` pubkey. Back up `SECRET` (or
`RELAY_PRIVATE_KEY`) like any other credential; losing it changes the relay's
identity and invalidates peers that trust the old pubkey.

## Configuring peers

Peers are configured by pubkey, with the URL used to reach them outbound:

```yaml
peering:
  enabled: true
  # ... this relay's own advertisement (contact, endpoint, scopes, terms) ...
  peers:
    - pubkey: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      relayUrl: wss://peer.example.com
      enabled: true
    - pubkey: npub1...
      relayUrl: wss://archive.example.com
```

`pubkey` accepts hex or `npub1...`. `enabled` defaults to true. Duplicate pubkeys
are rejected by settings validation, including the same key written once as hex
and once as an `npub`. `relayUrl` is also the value used for the NIP-42 `relay`
tag, so its host must match the peer's advertised `info.relay_url`; connect to a
relay through a hostname it does not advertise and AUTH will be rejected.

`peering.enabled` controls the NIP-11 advertisement. `peering.peers` is the
trust list and is independent of it: a relay can keep configured peers while its
advertisement is turned off.

## Inbound: recognizing a peer

1. The relay sends `["AUTH", "<challenge>"]` when a WebSocket connects.
2. The peer sends `["AUTH", <kind 22242 event>]` with `relay` and `challenge`
   tags, signed by its relay key.
3. `AuthMessageHandler` verifies the event id, signature, timestamp window,
   challenge, and relay-URL domain match.
4. If verification succeeds, the authenticated pubkey is added to the
   connection's NIP-42 session.
5. If that pubkey is an enabled `peering.peers` entry, the connection is marked
   as a peer. The peer pubkey is attached to the ephemeral connection state.

Peer status is cleared when the NIP-42 session expires or the socket closes.
Any other pubkey — including a valid signature from an unconfigured relay — is
authenticated as an ordinary client and receives no peer recognition.

## Outbound: authenticating to a peer

`authenticateToPeeringRelay` connects to a peer, waits for its AUTH challenge,
builds the same kind 22242 event with this relay's keypair, sends it, and
resolves only after the peer answers `OK true`. The returned socket is open and
authenticated for the caller to use for a feed or negentropy session. This
proves our identity to the peer; it does not verify the peer's identity in
return.

## Feed treatment

Once a connection has proven a configured peer pubkey, its subscription and
message limits come from `limits.peer`, not `limits.client` or `limits.message`:

- Peer subscription caps (`maxSubscriptions`, `maxFilters`, `maxFilterValues`,
  `maxSubscriptionIdLength`) are separate and larger by default.
- `limits.peer.subscription.maxLimit: 0` leaves REQ `limit` uncapped, so a peer
  can request a full feed instead of the client-sized page.
- Peer messages are counted in a separate rate-limit bucket, so a feed never
  trips the client EWMA limiter. The default is a high but finite bound, not an
  exemption.
- Only a verified AUTH from an enabled `peering.peers` pubkey selects these
  limits. An unauthenticated or unconfigured connection stays on the client
  limits exactly as before.

Scope enforcement (only the agreed kinds and time ranges) is part of the sync
work; this phase grants feed-sized limits to trusted peers.

Only the public half of the keypair is ever visible on the wire. Inbound AUTH is
verified by `AuthMessageHandler`: event id, signature, timestamp, challenge, and
relay host. Outbound AUTH proves this relay's identity to the peer; it does not
authenticate the remote relay, because NIP-42 is a client-to-relay proof. The
remote relay's identity is established separately by the configured
`peering.peers` pubkey (and, in later phases, by discovery and owner
attestation).
