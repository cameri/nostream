# ADR 0004: The wire transport and the differential fixture (job 008)

- **Status:** accepted (job 008, Phase 2 slice 2)
- **Deciders:** the rewrite team, on the evidence in job 008's recon and spec
- **Date:** 2026-10-23

## Context

The relay crate was a stub map: the daemon accepted a socket and dropped it, the
transport was a unit struct, and the five message handlers had no parameters. Job 008
ports the wire: the handshake, the per-socket state machine, the five handlers, the
rate limiters, live dispatch, the drain, and the two oracles that decide whether the
port is faithful — a checked census of the capture's 658 unit cases and a recorded
frame-session fixture replayed against the Rust relay.

This ADR records the decisions the code does not show on its face. Each heading is
greppable.

## Transport — `tokio-tungstenite` 0.30, compression declined

The transport is `tokio-tungstenite` 0.30 (`connect`, `handshake`), whose
`WebSocketConfig` bounds both a frame and a reassembled message, so a fragmented message
cannot grow past `network.maxPayloadSize` either. No feature of that crate offers
`permessage-deflate`; implementing the extension by hand would be a project of its own
for a wire the capture runs with compression off (`perMessageDeflate: false` in its
server adapter). A client's offer is therefore declined: the 101 response carries no
`Sec-WebSocket-Extensions`, and every frame is uncompressed. `tests/transport.rs::
a_declined_compression_offer_leaves_the_session_uncompressed` and the fixture's
`compression-offer` session hold that boundary; an approver who wants the extension
itself should scope a job for it.

The write path is one function. `transport::send_text` is the only place a string
becomes outbound bytes, `transport::classify` the only place an inbound `tungstenite`
message is matched, so a second write path cannot appear unnoticed.

## Rate limiters — the in-process store, behind a trait

The capture reaches Redis through module-level singletons built from
`rateLimiterFactory`. Two windows exist and their scripts differ in ways that matter:
the sliding window records a hit only when it is allowed, the EWMA records it even when
it refuses, and an EWMA key expires at `ceil(period / 1000)` seconds while a sliding
entry drops inclusively at `now - period`. Both are implemented in process over a
`Mutex`, behind a `Limiter` trait, because the behaviour under test is the window's
arithmetic and the wiring, not the transport to a shared store. A store error is
fail-closed: the event is answered `rate-limited: slow down` with no backoff, which is
what the capture's catch does. A later job that wants a shared store implements
`Limiter`; nothing in the handlers changes.

`RateLimits` keeps the four levels (`connection`, `message`, `event`, `invite`) and
their whitelists, and `Limiter` is injectable so the failure path is exercised rather
than asserted by inspection.

## Determinism seams — the clock and the fixture's randomness

Two values on this wire are not derived from anything the client sends: the current
time and the bytes the relay itself mints. Time is `nostream_core::clock::Clock`, with
`SystemClock` in the daemon and `TestClock` in tests; no handler reads `SystemTime` or
`Instant` (AC37's grep is empty).

Randomness is `nostream_core::random::RandomSource`, for the same reason and with the
same shape: `SystemRandom` in the daemon, `SeededRandom` (SplitMix64) and
`RecordedRandom` in fixtures. The capture mints the NIP-42 challenge (32 bytes) and a
NIP-43 invite code (16 bytes) from `crypto.randomBytes`, and the AUTH event's id and
signature are computed over the challenge, so a replay that substituted a different
challenge could not verify. The generator records the bytes its relay minted, and the
replay hands the relay exactly those, which keeps `{{challenge}}` a placeholder in the
recorded text while proving the relay verifies *its own* challenge rather than a
constant.

Signing draws no randomness in the generator: BIP-340 takes a fixed auxiliary random,
so the fixture's stream carries only what the relay minted.

## The fixture uses in-memory doubles, not Postgres

LMDB is still a stub and the capture's Postgres path needs a server a fixture cannot
assume. The generator's JS doubles and the Rust test doubles are therefore two
implementations of the same few repository behaviours: insert returns a row count,
filter reads stream rows, count aggregates, `find_actionable_targets` returns targets,
admission answers per pubkey, NIP-05 rows answer per pubkey, invite creation records
what was minted. Storage *semantics* are job 007's oracle, not this one's.

## The oracle's comparison, and its two exceptions

`tests/wire_parity.rs` replays each of the sixteen sessions the spec names, comparing
frames as raw UTF-8 text in order after `{{challenge}}` substitution. A tolerance may
only be declared per step, and only two exist: **T1**, the detail after `invalid: ` for
unparseable JSON (V8's parse diagnostics are not reproducible; the prefix is), and
**T2**, the reason text of a close frame whose code matches. The fixture declares T1 for
the one malformed-JSON step and nothing else.

Two steps are compared as JSON values rather than text, and the fixture says so per step
(`compare: "json"`, with a `compare_why`):

- **A REQ result and the minted claim event.** The capture's in-memory event objects
  carry field insertion order into `JSON.stringify`, and its paths do not agree: a
  stored row is emitted as `id, kind, pubkey, created_at, content, tags, sig`, a
  broadcast of the stored event as `id, pubkey, created_at, kind, tags, content, sig`,
  and the invite-code builder as `pubkey, kind, created_at, content, tags, id, sig`. One
  Rust serializer cannot produce three orders, and JSON has no field order on the wire,
  so both sides are parsed and the values compared: the same keys, the same values, the
  same array order. One difference inside a relay-minted event is accepted on top of
  that — a signature depends on the auxiliary random the signer drew — and it is
  accepted only when the observed signature verifies against the observed event, so the
  frame's content is checked rather than skipped. Everything else — the challenge, every
  NOTICE, OK, EOSE, CLOSED and COUNT frame, the broadcast EVENT frames, the close codes
  and the drain — is compared as text.
- **`no-secret`.** With no `SECRET` the capture logs the failure inside its rate-limit
  step and sends nothing; the Rust relay resolves the key at the same step and answers
  `["OK",<id>,false,"error: unable to process event"]`, which is the behaviour
  `handlers.rs` pins and AC29 asks for. The session is recorded (`comparison:
  "skipped"`), and its frames are compared against the harness's own AC29 constant
  rather than the recording, so the session is not unchecked.

Both exceptions are counted: `the_not_byte_compared_steps_are_exactly_the_declared_two_and_one_session`
fails if another step or session joins them, and `a_corrupted_expected_frame_fails_the_replay`
shows that a garbled expectation fails in either mode.

## Rate-limiter stores reclaim their keys, and refuse rather than displace

The capture's two Lua scripts set a TTL on every key (`PEXPIRE key period`,
`EXPIRE key ceil(period / 1000)`), and the in-process stores carry the same lifetime: one
`retain` pass drops every entry past **its own** window. The pass runs at most once per
`SWEEP_INTERVAL_MS` (one second), a cadence that belongs to the store — never to the
caller's window, or one hit on an hour-long window would postpone reclaiming every
one-second key for an hour.

The pass is *not* free and it is not off the request path: it runs inside the caller's
`hit`, holding the store's mutex for the whole pass, so the caller that triggers it waits
for it and a concurrent `hit` queues behind it. Two passes have to be sized differently:

- **A pass that frees nothing** — the common one, whenever a store sits at its ceiling
  between lapsings — measured 0.32–0.78 ms over 65,536 sliding keys at this head, and
  1.3–2.0 ms in round 2's busier conditions.
- **A pass that reclaims the whole store** — the one that clears a full level and so the
  one a client waits behind at the moment the level reopens — measured **4.26–5.06 ms**.

The one-second cadence bounds *how often* the lock is held, not *how long*: the worst
single stall a client can be made to pay is the reclaiming pass, 5 ms and not 0.8. Behind
a no-op pass a concurrent `hit` waited 0.96–1.16 ms. Taken together the cost measured
0.035–0.380 % of a core under continuous load, with a slow flood paying 0.482 ms/s.
Sweeping on each refused insert instead made a 131,072-key test take 193 s against 0.2 s,
and would have given a flooding client O(store) work per message.

Each of the four levels has a store of its own, so a flood of message keys cannot fill the
store the event level uses.

The map is capped at `MAX_STORE_KEYS` (65,536) per store, and a key that arrives when the
store is full and nothing has lapsed is **refused**, with its hit answered as limited. The
earlier policy — displace an arbitrary key — was wrong: a client that mints keys could free
a live key, its own or a third party's, and reset an exhausted window (measured on this
branch: a 240-per-hour message limit reset by another client's 80,000-event flood).
Refusal yields `limited`, which is precisely the outcome a flooding client is trying to
escape, so it is strictly safer; the cost is that a brand-new key is limited while the
store is full.

Two limits worth recording rather than discovering in production:

- **The ceiling bounds keys, not bytes.** It is per store, and there are four stores. The
  shipped EWMA strategy keeps one entry per key, so a full store holds `MAX_STORE_KEYS`
  (65,536) entries and the whole limiter holds four times that. The sliding strategy keeps
  one entry per hit instead — its 60-per-minute windows cap a key at 60 entries and its
  hour window at 720 — so a full *sliding* store is 65,536 × 720 entries, about 1 GB, and
  is reachable only at ~47 million accepted events.
- **A full level is closed to new keys until entries lapse, and the four levels are not
  alike.** A store fills at 65,536 keys (measured); how many *clients* that is, and how long
  the closure lasts, follow from the windows the key is built with
  (`resources/default-settings.yaml`):

  | level | keys per client | clients to fill | closure |
  | --- | --- | --- | --- |
  | connection | 2 — `{address}:connection:{period}`, windows 1 s and 60 s | 32,768 addresses | ≤ 61 s |
  | event | **1 to 7** — one 60 s key per kind window the event matches, plus the global hour key | **9,400–65,536 authors** (see below) | **depends on the kind** (see below) |
  | message | 1 — `{address}:message:60000` | 65,536 addresses | ≤ 61 s |
  | invite | 1 — `{pubkey}:invites:3600000` | 65,536 pubkeys | **≤ 1 h + 1 s** |

  Each cell is window **+ up to one sweep interval**, not the window alone: a lapsed key is
  only removed by a pass, the pass runs at most once per `SWEEP_INTERVAL_MS` (1 s), and a
  full store refuses a new key until one has run (`limits.rs`, `admit`). The invite row
  therefore reopens at 1 h + 1 s rather than 1 h.

  The event level's key count is a property of the *kinds an author uses*, not of the level.
  `resources/default-settings.yaml` ships six kind-scoped 60 s windows — `0,3,40,41`;
  `1,2,4,42`; `5–7,43–49`; `10000–19999,30000–39999`; `445`; `20000–29999` — and the key is
  `{pubkey}:events:{period}:{kinds}`, so the selector set names the key (`limits.rs`,
  `event_backoff`). A kind outside all six windows — `8–39`, `50–444`, `446–9999`,
  `40000–65535` — spends only the hour key: 65,536 such authors fill the store and are
  refused until 1 h + 1 s. An author posting one kind from each window holds all seven keys,
  so 65,536 ÷ 7 ≈ 9,400 authors fill the same store; their 60 s keys lapse first, which
  reopens it at 61 s, and a *sustained* flood then accumulates hour keys until those alone
  reach the ceiling — that is the hour-long closure, and it follows from the kinds such a
  flood picks, not from the level. A single-kind flood is the common case of two keys:
  32,768 authors, reopening at 61 s. Both ends were measured in the round-4 probe: kind 1 →
  32,768 authors reopening at 61 s, kind 9999 → 65,536 authors still refused at 61 s and
  admitting at 1 h + 1 s.

  The closure is per level and it never touches the others, which is the point of four
  stores; it is the price of never freeing a live key. This is also the reason a level's
  key count is not a client count: the event level spends one, two or seven.
- **A relay with no signing key does not rate-limit EVENT at all.** The event key is
  resolved before the limiter (the capture's `isRateLimited` calls `getRelayPublicKey()`,
  which throws), so with neither `SECRET` nor `RELAY_PRIVATE_KEY` set every event is
  answered `error: unable to process event` — AC29's declared outcome — and no window is
  consulted (`handlers/event.rs`, "no relay signing key; refusing the event"). The relay
  logs that at `debug`, so a deployment that wants to see it must run with `debug` enabled;
  one that wants the limiter must set a key.

## The accept loop lives in the relay, and serving cannot fail

Spec R1 says the acceptor hands the accepted socket to the relay; this job hands the
*listener* over instead (`Acceptor::run` → `Relay::serve`), because the drain deadline and
the `JoinSet` the drain waits on are one decision, and a socket the relay must drain
cannot be owned by a loop that has already returned. `Relay::serve` therefore returns
nothing: an accept error is logged and the loop continues, and the drain is bounded by
`RelayConfig::drain_timeout`. `RelayError::Draining` and `RelayError::Transport` were
deleted with the `Result`: nothing constructed them.

Every collaborator is a constructor argument (`Relay::new(settings, stores, clock, keys,
random, config)`) rather than a setter, so the randomness a fixture replays is the one the
relay was built with. `RelayConfig::default()` is the capture's own constants and reads no
environment: `WS_DRAIN_TIMEOUT_MS` is resolved by `transport::drain_timeout()`, which
`main.rs` calls when it builds the config, so a `default()` anywhere else — a test suite
included — cannot inherit the operator's deadline by accident.

## A strategy is a type, and its signature is `(event, context)`

The capture's `IEventStrategy.execute(event, sink)` becomes
`EventStrategy::execute(&self, event: &Event, context: &HandlerContext)`: a strategy
writes through the context's sink and needs the context's stores, settings and clock
(the default arm calls `EventRepository::create` and the broadcast hub, neither of which a
bare sink carries). Every arm — the filled `DefaultStrategy` and the fourteen stubs — is a
zero-sized type implementing the trait, so job 009 changes a body rather than choosing
between two shapes.

## Two orders the capture leaves unspecified, fixed deliberately

- **Subscriptions are walked in id order.** The capture's `Map` walks insertion order; the
  port's `Connection` keeps a `HashMap` and sorts on read (`Connection::subscriptions` sorts
  by id), so a drain or a fan-out emits `CLOSED`/`EVENT` frames in id order. Observable only
  when a client's ids are not alphabetical, and the fixture's ids are sorted.
- **The connection-level limit is keyed on the peer address, and decided after the
  upgrade.** Not before it: the capture's check lives in `onConnection`
  (`src/adapters/web-socket-server-adapter.ts:126-143`), which runs after the handshake and
  before the adapter is registered, and the port does the same — `Relay::handle_socket`
  upgrades (`relay.rs:217`), asks `is_connection_rate_limited` (`:225`), and only then
  enters `run_connection` (`:230`). A refused client therefore completes the handshake and
  is dropped without a close frame or a registration, as the capture's `terminate()` does.
  It keys on the accept loop's `peer` because no `Connection` exists yet; that is the same
  string `Connection::remote_address` derives from the transport, since the port
  implements neither `network.remoteIpHeader` nor `network.trustedProxies` (the only way
  the capture's two keys differ). The consequence is worth stating where the limit is
  described, because the settings do carry both fields (`settings.rs:71,73`) and the shipped
  defaults set `trustedProxies`: the header-derived address lands with the HTTP surface
  (daemon/admin), and until then a relay behind a reverse proxy sees every client as the
  proxy's address. One connection bucket then serves the deployment, so this level's limit
  and the closure recorded below apply to the proxy rather than to each client.

## The hidden-content mirror is the relay's

`src/utils/hidden-content-cache.ts` polls the report repository on an interval that
depends on the settings, so the mirror lives in `nostream-relay::hidden_content` and
`nostream-storage` owns only the query it calls. `Relay::serve` starts the refresh task
and aborts it when the loop ends; dropping the handle would detach the task, so the
handle's owner is the caller that started it.

## The census is a checked artifact

`tests/fixtures/ts-cases.json` is the 658 case titles of the 36 in-scope spec files,
regenerated by `tests/capture/gen-ts-cases.mjs` from the capture tree.
`tests/fixtures/ts-case-map.json` maps each title to the Rust test that carries it, and
`tests/ts_case_parity.rs` fails when a case has no mapping, a mapped test is absent or
`#[ignore]`d, or a per-file count disagrees with the spec's table. 46 cases are explicit
exemptions with a reason and the job that owns them (`processNip05Metadata`, the
admission cache, admission fee schedules, the process-level shutdown deadline).

## NIP-43 `info.self` — hex only

The capture accepts a hex pubkey or an `npub` in `info.self`; the port accepts hex and
refuses an `npub` with a log line, because the port's decoder has no bech32 and a
mistyped identity must not mint invite codes. Job 010 (NIP-05/bech32 surface) can widen
it.

## WoT distance is unavailable, so adaptive PoW charges in full

`apply_wot_pow_policy` needs a distance from the trust graph, which is not ported. With
no distance the computed difficulty is charged in full, which is the capture's behaviour
for a pubkey outside the graph; the thresholds themselves are ported and tested.
