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
   peer must advertise NIP-77. URL literals and resolved DNS addresses that are
   loopback, private, or link-local are refused, including on redirects.
2. Authenticate with NIP-42 using this relay's keypair.
3. Open the live `REQ` first, starting from a short overlap so events published
   while history is syncing are not lost. A rolling `windowSeconds` is checked
   against the current time, and never widened past its own cutoff.
4. Reconcile each advertised scope with a NIP-77 negentropy session. A scope is
   split into filters by kind range and, if the peer still rejects it as too
   large, by time range. Only the ids the peer has and we lack are fetched, in
   `REQ` batches, so an empty peer converges without a full dump.
5. Reconcile again every 15 minutes. Any disconnect reconnects and reruns the
   reconciliation, which closes any gap the live feed missed.

Fetched and live events are accepted only when they match the scope, were
requested by id, and pass id and signature verification. They are then applied
with the same kind rules as locally published events: addressable events keep
their `d` tag as the deduplication key, kind-5 deletes hide their targets, and
kind-62 requests delete the author's events and set the vanish flag only when
their relay tags target this relay. Ephemeral events are broadcast live but
never stored. Authors under an active vanish request are skipped, with the
vanish check cached once per author per batch. Live events are also broadcast to
local subscribers, so a peer feed is indistinguishable from a locally published
event to this relay's clients. Backfilled history is not broadcast, because it
predates any live subscription.

If the peer rejects a filter as too large, the worker splits it by kind and then
by time range and retries. A fetch batch that exceeds the byte budget is split
into smaller batches without dropping the connection. The live queue and fetch
buffers are bounded by both count and bytes, and a failing live event is logged
without stalling the rest of the queue. The per-peer state heartbeat keeps a long
reconciliation from being reported as stale.

Each reconciliation writes the peer's state to Redis and exposes it at
`GET /admin/peering`: status, last reconciliation, latest event age ("lag"),
the number of events the last reconciliation found missing, and how many events
it stored. The admin console shows the same rows under Operations → Peering,
with the peer's current terms and an explicit relationship state (`active`,
`suspended`, `lapsed`, `unpaid`, `free` or `removed`). It also shows reconciled
events, peer requests and all events served, plus the per-peer and global
budget counters and held invoices with Approve/Reject actions.

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

## On-demand requests

Beyond the standing feed and periodic reconciliation, an authenticated peer may
ask for specific events with an ordinary `REQ`, `COUNT`, or an ad-hoc `NEG-OPEN`
session. This covers an event outside the advertised scope — for example the
root of a thread, or a deeper backfill — without changing either relay's feed
configuration.

These requests are served under the peer's normal subscription and NIP-77
limits, not client limits, and are additionally throttled per peer pubkey by
`limits.peer.request.rateLimits`. The default budget is 300 requests per minute
across `REQ`, `COUNT`, and `NEG-OPEN`; a refused `REQ`/`COUNT` receives
`CLOSED` with a `rate-limited:` reason and a retry hint, and a refused
`NEG-OPEN` receives `NEG-ERR`. The limiter fails closed if its store is
unavailable.

The same request pattern from a non-peer connection is handled as ordinary
client traffic and is not given the peer budget.

Request counts and the number of events served are recorded per peer pubkey in
Redis and shown in the admin console's Peering table alongside sync state. The
same counters are included in diagnostics exports. Accounting is best-effort
and never fails the request it describes.

Only the public half of the keypair is ever visible on the wire. Inbound AUTH is
verified by `AuthMessageHandler`: event id, signature, timestamp, challenge, and
relay host. Outbound AUTH proves this relay's identity to the peer; it does not
authenticate the remote relay, because NIP-42 is a client-to-relay proof. The
remote relay's identity is established by the configured `peering.peers`
pubkey. When `peering.ownerAttestation` is `required`, an accepted owner-signed
request must also exist before peer treatment is granted. Discovery remains a
later phase.

## Owner attestation

A relay keypair is free to mint, so peering can optionally be backed by the
operator's own key. The relay owner signs a one-time request; the relay key
proves itself on the same NIP-42 connection. The request names the relay's
pubkey and URL, the scopes it accepts, and a hash of the advertised terms. The
receiver checks:

- the owner signature and event id;
- that the request's relay pubkey is authenticated on this connection;
- that the request targets this relay and is fresh;
- that the scopes and terms still match this relay's NIP-11 advertisement;
- that NIP-13 proof-of-work meets `peering.minRequestPowDifficulty`.

`peering.ownerAttestation` controls the policy:

- `waived` — configured peers are trusted without a request (default).
- `preferred` — a presented request is recorded, but peers are not blocked.
- `required` — a configured peer gets no peer treatment until an accepted
  request exists for its key.

Requests are only accepted from relays already listed in `peering.peers`;
discovery is a later phase. Add the requesting relay's pubkey on the receiver
first. Configured peers skip the proof-of-work requirement by default
(`peering.waiveRequestPowForConfiguredPeers`). Set `peering.peers[].ownerPubkey`
to require a specific operator key rather than accepting any owner signature
for that relay.

Produce and send a request from the requesting relay:

```bash
PEERING_OWNER_PRIVATE_KEY=<owner hex> \
  nostream peering request wss://peer.example.com --json
```

The command reads the peer's NIP-11 document, requests its advertised scopes
and terms, grinds the advertised proof-of-work, authenticates with this relay's
key, and prints the accepted request and relay-signed acceptance. The owner key
is used only for this establishment request; invoices, renewals and on-demand
event requests never ask for it.

## Paid peering

When `peering.terms` contains exactly one positive term, this relay sells the
feed instead of serving it settlement-free. Terms use the NIP-11 fee-object
shape (`amount`, `unit`, `period`); `unit` must be `msats`, `sats` or `btc`, and
a paid `msats` amount must be a whole number of satoshis so every payment
processor charges the same value. Payments must be enabled.

The buyer, Relay A, has no relationship with this relay's payment processor.
The invoice travels over the authenticated relay connection:

1. Relay A authenticates with NIP-42 and sends
   `REQ {"kinds":[402],"#p":["<A pubkey>"],"#t":["peering"],"limit":1}`.
2. Relay B creates a BOLT11 invoice with its existing payments processor and
   persists it with `invoices.purpose = peering` and a snapshot of the term.
3. Relay B publishes a signed `kind 402` event tagged `p` (Relay A), `t`
   (`peering`), `bolt11`, `i` (processor invoice id) and `expiration`.
4. Relay A pays the invoice. The processor calls Relay B's existing callback,
   or the billing worker finds the payment by polling. Settlement validates the
   amount and extends `peering_payments.period_end` exactly once.
5. Feed access is allowed while `period_end` is in the future. An unpaid period
   marks the peer `lapsed`, closes its peer sockets, and refuses feed `REQ`,
   `COUNT` and `NIP-77`; it does not delete events or sync state.
6. Renewal is the same loop: the billing worker issues a renewal invoice before
   the period ends and publishes it on the same `kind 402` path.

An expired invoice is retired and reissued on request after a short cooldown.
Before denying access, the relay rechecks a pending invoice with the processor,
so a missed webhook heals on its own.

A completed peering invoice whose settlement transaction rolled back stays
retryable. Every failed settlement increments `settlement_attempts` and stores
`last_settlement_error` on the invoice; the maintenance worker keeps retrying.
After `peering.settlementFailureThreshold` failures (default 5), the relay
enqueues one `peering.payment.failed` operator notification and keeps retrying.
Duplicate callbacks and underpayments are not counted as settlement failures.
Only completed invoices that are still unconfirmed are counted; a pending row
checked through the processor recheck path stays on the pending page. If the
processor later reports a non-completed status for a completed but unconfirmed
peering invoice, the worker ignores the downgrade and keeps the completed
marker so settlement remains retryable. A peer can always authenticate and ask
for its invoice, even while lapsed, but cannot read the feed.

Billing state is stored in `peering_payments`, one row per peer and direction
(`sell` here; `buy` is reserved for the paying side). `GET /admin/peering`
merges it with the sync and request rows, showing status, access end, the open
invoice and the last processor error.

## Buying side: auto-pay and budgets

The relay can also be the buyer. It subscribes to the `kind 402` invoice stream
of every enabled peer that advertises a paid term, over the same authenticated
peering connection it uses for the feed. Invoices are deduplicated by BOLT11
payment hash, so a redelivered event or a reconnect never pays twice.

Auto-pay is opt-in and requires a per-peer budget:

```yaml
peering:
  autoPay:
    enabled: true
    # Optional cap across every peer, per its own period. Zero means no cap.
    globalBudget: { amount: 100000, unit: sats, period: 2592000 }
  peers:
    - pubkey: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      relayUrl: wss://peer.example.com
      budget: { amount: 10000, unit: sats, period: 2592000 }
```

An invoice is paid automatically only when all of these hold:

- the event is signed by the configured peer pubkey and p-tagged to this relay;
- its BOLT11 amount equals the single paid term in the peer's NIP-11 document;
- the payment hash has not been seen before;
- the per-peer budget, and the optional global budget, have room in the current
  period.

Budget windows are fixed and epoch-aligned. A renewal inside the same window
counts against the same counter, and auto-pay never borrows from the next
window. The counters are updated atomically before the wallet is called, so two
workers cannot both spend the last unit of a budget.

Anything else is stored as a **held** invoice and shown under Operations →
Peering invoices in the admin console. The reason is one of `amount_mismatch`,
`unknown_peer`, `budget_exceeded`, `budget_not_configured`, `auto_pay_disabled`,
`payment_failed` or `expired`. Held invoices can be approved (paid manually) or
rejected. Manual approval is not limited by the auto-pay budget, but its spend is
still recorded. Every hold, payment and budget exhaustion feeds the existing
peering notification switches, so the operator can subscribe to
`peering.invoice.paid` / `peering.invoice.failed`.

Auto-pay uses the configured payments processor as the wallet. LNbits and NWC
can pay BOLT11 invoices; receive-only adapters hold every invoice because they
have no way to spend. The LNbits key must allow
**outgoing payments**, not only invoice creation/read access. An Invoice/read
key can create the relay's own invoices but cannot spend, so every buyer
invoice is held instead of paid. The buyer never credits a user balance and never touches
the seller's payment processor: the payment is a normal Lightning payment from
this relay's wallet to the BOLT11 invoice in the peer's signed event.
