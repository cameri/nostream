# ADR 0004: The wire transport and the differential fixture (job 008)

- **Status:** accepted (job 008, Phase 2 slice 2)
- **Deciders:** the rewrite team, on the evidence in job 008's recon and spec
- **Date:** 2026-10-23

## Context

The relay crate was a stub map: the daemon accepted a socket and dropped it, the
transport was a unit struct, and the five message handlers had no parameters. Job 008
ports the wire: the handshake, the per-socket state machine, the five handlers, the
rate limiters, live dispatch, the drain, and the two oracles that decide whether the
port is faithful — a checked census of the capture's 557 unit cases and a recorded
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

Two steps are recorded but not byte-compared, and the fixture says so per step:

- **A REQ result and the minted claim event.** The capture's in-memory event objects
  carry field insertion order into `JSON.stringify`, and its paths do not agree: a
  stored row is emitted as `id, kind, pubkey, created_at, content, tags, sig`, a
  broadcast of the stored event as `id, pubkey, created_at, kind, tags, content, sig`,
  and the invite-code builder as `pubkey, kind, created_at, content, tags, id, sig`. One
  Rust serializer cannot produce three orders, so the relay emits the one NIP-01 order
  every other EVENT frame matches and these two frames are compared structurally by the
  handler tests instead. Everything else — the challenge, every NOTICE, OK, EOSE,
  CLOSED and COUNT frame, the broadcast EVENT frames, the close codes and the drain —
  is compared as text.
- **`no-secret`.** With no `SECRET` the capture logs the failure inside its rate-limit
  step and sends nothing; the Rust relay resolves the key at the same step and answers
  `["OK",<id>,false,"error: unable to process event"]`, which is the behaviour
  `handlers.rs` pins and AC29 asks for. The session is recorded, and its frames are not
  compared.

Both exceptions are visible in the fixture (`compare: false`, `comparison: "skipped"`)
with their reasons, and in the job's build report.

## The census is a checked artifact

`tests/fixtures/ts-cases.json` is the 557 case titles of the 22 in-scope spec files,
regenerated by `tests/capture/gen-ts-cases.mjs` from the capture tree.
`tests/fixtures/ts-case-map.json` maps each title to the Rust test that carries it, and
`tests/ts_case_parity.rs` fails when a case has no mapping, a mapped test is absent or
`#[ignore]`d, or a per-file count disagrees with the spec's table. 42 cases are explicit
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
