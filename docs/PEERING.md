# Peering identity

Relay peering lets one relay serve feeds to another. Before any feed exists, each
side must be able to prove which relay it is: a URL is an address, not an
identity. Nostream uses NIP-42 AUTH signed with the relay's own keypair for that
proof, and a configured pubkey list for trust.

This document covers relay identity, peer-aware feed treatment, and outbound
sync. On-demand requests, payments, and the full admin console build on it.

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

## Outbound sync

Sync is driven by the peer's advertisement, not by a second config-file feed
list. For every enabled `peering.peers` entry the relay starts one peering-sync
worker session:

1. Read the peer's NIP-11 document and its `peering.scopes`. The document's
   `self` must match the configured peer pubkey when it is present, and the
   peer must advertise NIP-77.
2. Authenticate with NIP-42 using this relay's keypair.
3. Reconcile each advertised scope with a NIP-77 negentropy session. The scope
   is a filter built from its kinds (ranges expanded) and time range; a rolling
   `windowSeconds` becomes a `since` at reconciliation time. Only the ids the
   peer has and we lack are fetched, in `REQ` batches, so an empty peer
   converges without a full dump.
4. Open one live `REQ` for the same scopes, starting from a one-minute overlap
   so an event published while reconciliation was running is not lost.
5. Reconcile again every 15 minutes. Any disconnect reconnects and reruns the
   reconciliation, which closes any gap the live feed missed.

Fetched and live events are accepted only when they match the scope, were
requested by id, and pass id and signature verification. They are then applied
with the same kind rules as locally published events: addressable events keep
their `d` tag as the deduplication key, kind-5 deletes hide their targets,
kind-62 requests delete the author's events and set the vanish flag, and
ephemeral events are broadcast live but never stored. Authors under an active
vanish request are skipped. Live events are also broadcast to local subscribers,
so a peer feed is indistinguishable from a locally published event to this
relay's clients. Backfilled history is not broadcast, because it predates any
live subscription.

If the peer rejects a scope as too large, the worker splits it into smaller time
ranges and retries. Fetched id batches are bounded by both count and bytes, and
the live queue closes the connection rather than growing without limit when a
peer sends faster than writes finish.

Each reconciliation writes the peer's state to Redis and exposes it at
`GET /admin/peering`: status, last reconciliation, latest event age ("lag"),
and the number of events the last reconciliation found missing. The admin
console shows the same rows under Operations → Peering.

NIP-77 must be enabled on the source relay (`nip77.enabled` and the PostgreSQL
event store). `peering.peers` on the receiving relay is the only trust material
an operator supplies.

## Feed treatment

Once a connection has proven a configured peer pubkey, its subscription and
message limits come from `limits.peer`, not `limits.client` or `limits.message`:

- Peer subscription caps (`maxSubscriptions`, `maxFilters`, `maxFilterValues`,
  `maxSubscriptionIdLength`) are separate and larger by default.
- `limits.peer.subscription.maxLimit: 0` leaves REQ `limit` uncapped and makes an
  omitted `limit` query the full stored feed instead of the client-sized
  500-event default. A positive value becomes the peer's default page size.
- Peer filter counts are bounded by `limits.peer.subscription.maxFilters`, not
  the client cap, so a full-feed filter set is not rejected before the handler
  can apply peer limits. The raw count is checked before duplicate removal, so
  a large set of duplicate filters cannot stall the worker in `uniqWith`.
- Stored reads wait for the WebSocket send callback to report the previous
  frame as flushed, so a slow peer cannot grow the worker's outbound memory.
  Soft-deleted and expired events are excluded in SQL before the limit, so dead
  rows cannot consume a page slot.
- Peer messages are counted in a separate rate-limit bucket, so a feed never
  trips the client EWMA limiter. The default is a high but finite bound, not an
  exemption.
- Only a verified AUTH from an enabled `peering.peers` pubkey selects these
  limits. An unauthenticated or unconfigured connection stays on the client
  limits exactly as before.

Scope enforcement (only the agreed kinds and time ranges) is applied on the
outbound sync path: the sync worker reconciles only the peer's advertised
scopes and drops fetched events that fall outside them. Inbound feed scope
enforcement remains part of the sync work that is still in progress.

Only the public half of the keypair is ever visible on the wire. Inbound AUTH is
verified by `AuthMessageHandler`: event id, signature, timestamp, challenge, and
relay host. Outbound AUTH proves this relay's identity to the peer; it does not
authenticate the remote relay, because NIP-42 is a client-to-relay proof. The
remote relay's identity is established separately by the configured
`peering.peers` pubkey (and, in later phases, by discovery and owner
attestation).
