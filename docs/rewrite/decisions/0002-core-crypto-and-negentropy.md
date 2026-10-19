# ADR 0002: Core crypto, integral types and the negentropy crate (Phase 1)

- **Status:** accepted (job 006, Phase 1)
- **Deciders:** the rewrite team, on the evidence in job 006's recon and spec
- **Date:** 2026-10-19

## Context

`nostream-core` is the crate every other crate imports from, and until job 006 its
crypto, filter, NIP-13/40/44 and NIP-77 surfaces were typed stubs: `EventId` and
`Pubkey` were `String` newtypes, `Event.sig` was a `String`, and nothing checked hex,
length or a signature. Job 006 turns those surfaces into working code against the
TypeScript at the capture commit (`242a3001`), and delivers the differential oracle the
issue asks for: 1,000 events measured through the capture's own pipeline and replayed
through this crate (`crates/nostream-core/tests/ts_parity.rs`).

Three questions had to be answered before any code was written, because each one
shapes every later phase: which crates the core depends on for cryptography and
reconciliation; how a wire value that must be 32 bytes coexists with the lenient pubkey
text settings already hold; and what a `#[serde(flatten)]` tag map actually does with the
`#` in a JSON key.

## Decision — dependencies

All eight go in `[workspace.dependencies]` and are referenced as `name.workspace = true`
(`CLAUDE.md:82-84`); a version literal in a crate manifest is a defect.

| crate | version | why |
|---|---|---|
| `secp256k1` | 0.33.1 | BIP-340 Schnorr. In 0.33 the schnorr module is unconditional, `Keypair::from_secret_key` needs no context, `XOnlyPublicKey::to_byte_array` and `schnorr::sign_no_aux_rand` are the current forms, and `ecdh::shared_secret_point` returns the raw x-coordinate NIP-44 hashes. CC0-1.0, MSRV 1.63. |
| `sha2` | 0.11.1 | the event id and NIP-44's HMAC/HKDF. It replaces `bitcoin_hashes`, which would be a second SHA-256 for no gain. |
| `hmac` | 0.13.0 | NIP-44's MAC, verified with `verify_slice` (constant time). |
| `hkdf` | 0.13.0 | NIP-44's extract (`salt = "nip44-v2"`) and 76-byte expand. |
| `chacha20` | 0.10.2 | NIP-44's stream cipher, counter 0 with the 12-byte nonce — the same keystream as the capture's 16-byte IV of four zero bytes plus the nonce. |
| `base64` | 0.22.1 | NIP-44's `STANDARD` alphabet, which is what `Buffer.toString('base64')` produces. |
| `hex` | 0.4.3 | `decode_to_slice`/`encode_to_slice` for the newtypes, so the accepting path borrows the input and writes a fixed array. |
| `negentropy` | 0.5.2 | the NIP-77 engine; see below. MIT, no dependencies, MSRV 1.51. |

No `serde_with`, `bitcoin_hashes`, `hex-conservative` or `const-hex`: each would be a
second way to spell what `hex` already does. No `rand`/`getrandom`: the NIP-44 nonce is
an argument and signing is deterministic, so the crate never reaches for randomness.

## Decision — integral types and the settings split

`EventId([u8; 32])`, `Pubkey([u8; 32])` and `Signature([u8; 64])` replace the string
newtypes. The issue's "32-byte `EventId`/`Pubkey`/`Signature`" groups a 64-byte value
with two 32-byte ones; the capture agrees — `idSchema` and `pubkeySchema` are 64 hex
characters and `signatureSchema` is 128 (`src/schemas/base-schema.ts:11-19`), all
`^[0-9a-f]+$`. The type carries that shape check, through a borrowed visitor over
`hex::decode_to_slice`, and its `Ord` is byte order — the same order Postgres `bytea`
comparison and lowercase-hex string comparison produce, which the replaceable tie-break
depends on.

A separate `SettingsPubkey(pub String)` keeps operator text. Nine settings fields and
`EventRetentionOptions.pubkey_whitelist` move to it. The settings validator never checks
pubkey format (`src/utils/settings-config.ts` has no `pubkey` rule), so the default `""`
and a user value like `abc123` must survive — `crates/nostream-config/tests/defaults_parity.rs`
pins both, and it stays green. One type cannot be both lenient and 32 bytes; the split is
the only shape that keeps both contracts.

`mirroring.static[].filters` is the same capture type (`SubscriptionFilter`) but a different
consumer, and it does **not** narrow with the wire type: `crates/nostream-config`'s
`SettingsFilter` keeps `kinds: Option<Vec<KindSelector>>`.

The declared type is numbers-only (`src/@types/subscription.ts:8`, `kinds?: (EventKinds |
number)[]`); `EventKindsRange` types the settings criteria instead (limit and NIP-42 among
them, `src/@types/settings.ts:46,49,83,429`), not a subscription filter. The ground for the
wider settings type is the loader, not the type: the capture never validates a mirror filter
— `validateShape` returns when a sequence's schema is empty
(`src/utils/settings-config.ts:202-204`) and the defaults carry `mirroring.static: []` — so
`kinds: [[10000, 19999]]` is an unvalidated runtime value that loads there and must load
here. The two paths are distinct:

- **local matching** uses `into_matcher_filter()`, which drops a range element because the
  capture's matcher compared kinds with `Array.includes` on numbers, so a range never matched
  there either;
- **the outbound REQ** serialises `SettingsFilter` itself, as the capture does: the mirror
  worker forwards each filter verbatim with only `since` injected
  (`src/app/static-mirroring-worker.ts:72-77`) and `createSubscriptionMessage` sends it
  unvalidated (`src/utils/messages.ts:53-58`), so the range reaches the peer. Serialising
  `Filter` there would send `kinds: []`, which the capture never sends.

`crates/nostream-config/tests/mirror_filters.rs` pins the load, the round-trip and the
matching crossing.

Signing sets the author: `sign_event` writes `pubkey` from the key before hashing the id,
because the id is hashed over the pubkey and a returned event has to verify. The capture's
`signEvent` leaves the pubkey alone and would let a caller pair a key with the wrong author.

`Event` is `#[serde(deny_unknown_fields)]`, matching `eventSchema.strict()`
(`src/schemas/event-schema.ts:41`).

## Decision — tag-map keys

`Filter.tags` keeps `#[serde(flatten)] BTreeMap<String, Vec<String>>` and holds JSON keys
**verbatim**, `#` included: `{"#e":["aa"]}` deserialises to `tags["#e"]`. The old doc
comment said the keys were stripped, which the derivation never did. Verbatim keys are
what the capture's filter object holds (`src/@types/subscription.ts`) and what
round-trips the wire document unchanged; a stripped key would have to be re-prefixed on
serialise and would lose unknown-key fidelity. One test pins both directions.

`Filter.ids`/`authors` became `Vec<String>` prefixes (the schema admits 4..64
characters, so a validated `EventId` cannot carry them) and `Filter.kinds` became
`Vec<Kind>`: the TS matcher compares numbers with `includes`, so a range element never
matched, and making it unrepresentable states that structurally.

## Decision — filter validation messages

`validate_filter` reproduces the capture's **measured** zod 3 output, not the strings in
`test/unit/schemas/filter-schema.spec.ts`. That suite asserts only that an error exists;
the strings in its table are the case *names*. Measured against the capture tree:
`Expected array, received null`, `Expected number, received null`,
`Expected number, received array`, `Expected integer, received float`,
`String must contain at most 64 character(s)`, `String must contain at least 4
character(s)`, `String must contain at least 1 character(s)`, `String must contain at
most 1024 character(s)`, `Invalid` (the hex regex), `Number must be greater than or
equal to 0`, `Invalid timestamp`, `Unknown key: <key>`, `Invalid geohash filter`.

A message the capture never emits is a fabricated output, and the job's whole premise is
measurement, so the Rust messages are the measured ones; each parity test keeps its
mocha case name and asserts the measured string as well as `is_err`. Job 006's spec
(D11) listed the case names as if they were messages; the deviation is recorded here and
in `build.md`.

Two messages are **not** the capture's, and they say so in their own words:
`kind value does not fit in 64 bits` and `limit does not fit in 64 bits`. The capture accepts
`{"kinds":[1e20]}` and `{"limit":1e20}` (JavaScript numbers, no ceiling in `kindSchema` or
`limit`); `Kind` is a `u64` and `Filter.limit` a `u64`, so those values are unrepresentable
here. That is a representability divergence, not a validation rule, so imitating zod's
phrasing would be the fabrication this section forbids.

The refused cell is narrow: an integer **above** `u64::MAX`, or a float **at or above**
`2^64`. A JSON integer up to `u64::MAX` is carried exactly — `u64::MAX` itself included,
which the capture accepts and which `as_f64` would round up to `2^64` and refuse — and the
largest accepted `f64` is `2^64 - 2048` (`18446744073709549568`). `1e19` and
`9007199254740992` are accepted by both paths.

Length bounds count **UTF-16 code units**, as zod's `.min()`/`.max()` do through
`String.prototype.length`: `text.encode_utf16().count()`, not `chars().count()`. An astral
character is two units, so 600 emoji are 1200 units and are rejected by both paths. The
`Unknown key` second pass also runs over every key, including one whose value already failed
the catchall type check, where zod's `superRefine` only sees parsed keys: the Rust output can
be a superset of zod's on a document that is invalid either way, never on a valid one.

## Decision — negentropy crate and its divergences

NIP-77 is the `negentropy` crate 0.5.2 behind a seam (`negentropy.rs` re-exports the
crate's types and adds `storage_from_items`/`storage_from_events`). Porting the 548-line
TypeScript engine by hand would re-derive a protocol an implementation already speaks,
and the oracle for either choice is the same reference bytes: the crate's
`PROTOCOL_VERSION` is `0x61`, the capture's `NEGENTROPY_PROTOCOL_VERSION`
(`src/utils/negentropy.ts:9`), and all three reference wire vectors from
`test/unit/utils/negentropy.spec.ts:239-263` reproduce exactly.

Six of that suite's 44 cases test faults the crate makes unrepresentable rather than
refusing them, and a seventh came out of writing the parity module:

| TS case | behaviour against the crate |
|---|---|
| `rejects duplicate items when sealing` | `seal()` de-duplicates silently (`storage.rs:111-112`); the test asserts one item after seal |
| `hands out frozen items so callbacks cannot reorder a sealed set` | `Item` is `Copy`; a callback cannot reach the set |
| `is not affected by the caller changing an id buffer after inserting it` | `Id` is `[u8; 32]` by value |
| `rejects range indexes that are negative, fractional or not finite` | the parameters are `usize`; only `BadRange` exists |
| `rejects varints that never terminate` | `decode_var_int` (`encoding.rs:16-27`) has no length bound |
| `rejects varints beyond the safe integer range` | the same decoder accumulates into `u64` without a safe-integer check |
| `restarts a frame-truncated reply at the last written bound, not after the dropped range` | the crate takes the trailing fingerprint's lower bound from the current range's `upper`, not from where the written output stopped (`writtenUpTo` in `src/utils/negentropy.ts:313-317`), so it answers `fingerprint(160, 160)` where the capture answers `fingerprint(120, 160)`; the session still converges, in an extra round |

The NIP-77 **frame** encoder (`NEG-OPEN`/`NEG-MSG`/`NEG-CLOSE`) and the session state
machine stay out: `src/utils/nip77.ts` does not exist at the capture, and frames are wire
envelope with the subscription id — `nostream-relay`'s Phase 2.

## Consequences

- The core owns the semantics: event ids, signatures, filter matching and validation,
  normalisation, NIP-13 difficulty, NIP-40 expiration, NIP-44 v2, and reference-time and
  replaceable precedence. `validate_event` and `adaptive_pow` stay labelled stubs, and
  the hex/length checks they would have made now live in the types.
- Every new behaviour that needs a clock or randomness takes it as an argument
  (`is_expired_event(event, now)`, `check_created_at(..., now, ...)`,
  `encrypt(..., nonce)`); `time::unix_now()` is the single clock read. Determinism is
  what lets the differential fixture record decisions once and replay them.
- The signed-event path is deterministic (`sign_no_aux_rand`), so a signature is
  reproducible. The capture signs with noble's random auxiliary data; BIP-340 verifies
  both, so the difference is invisible on the wire.
- The seven negentropy divergences are behavioural, not structural: the relay's NIP-77
  session will converge with any reference peer, and the one that costs a round is
  recorded rather than papered over.
- Two crates changed shape: `nostream-config`'s settings and `nostream-storage`'s
  retention options now hold `SettingsPubkey`; `mirroring.static[].filters` holds
  `SettingsFilter` so the settings **loader** keeps the capture's kind-range acceptance. Nothing
  else moved, and no consumer outside those two crates names a filter differently.

## Revisit triggers

- **The negentropy crate's frame truncation (divergence 7).** If a NIP-77 session
  against a reference peer shows extra rounds on large frames, wrap the crate or vendor a
  `writtenUpTo` fix; the test in `tests/negentropy_parity.rs` names the exact behaviour.
- **A `negentropy` release that changes `Seal` semantics or the decoder's bounds** would
  move the other six rows; the parity module is the check.
- **`secp256k1` 0.34 or later**, if it changes the no-context keypair API or drops
  `shared_secret_point`; D7's three call sites are in `crypto.rs`.
- **If the acceptance gate finds a message contract** (an operator-facing string built
  from `validate_filter`), align it with the measured strings here before changing them.
- **If the mirror worker's outbound REQ path is built** and it needs the range element the
  capture forwards, serialise `SettingsFilter` there rather than `Filter`. `into_matcher_filter`
  has already dropped it, so that path must not route through it; this is the one place the
  dropped range would be observable.
- **If a surface must carry a JavaScript number a `u64` cannot hold** — a settings editor, or
  a path that re-serialises a filter the capture accepts — revisit
  `validate_kinds`/`validate_limit` (`filter.rs`): the capture holds that value, the Rust
  types hold everything up to `u64::MAX`, and only the cell at or above `2^64` (a float, or
  an integer literal past `u64::MAX`) is refused. A surface that can hold the higher value may
  keep it instead of refusing.
- **If a signing path must preserve a caller-supplied author** — NIP-26 delegation, or a relay
  signing for another author — add a second function. `sign_event` overwrites `pubkey` by
  design, and weakening it would restore the silently invalid event round 2 removed.
- **If a surface treats Rust issue counts as normative**, revisit the `Unknown key` superset
  above: `validate_filter` can report one issue more than zod on a document that is invalid
  either way, so a count-for-count comparison of that surface is not the right oracle.
- **If NIP-40 retention is ever measured against the capture** on non-decimal `expiration`
  tag values, `expiration::js_number` is the seam that already covers `0x`/`0o`/`0b`,
  trimmed and exponential forms; extend it there rather than in the tag walk.
