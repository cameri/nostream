# ADR 0006: The fourteen event strategies, their two seams, and the census that carries them (job 011)

- **Status:** accepted (job 011, Phase 2)
- **Deciders:** the rewrite team, on the evidence in job 011's recon and spec
- **Date:** 2026-10-24

## Context

Fourteen of the relay's fifteen `EventStrategy` arms answered
`RelayError::NotImplemented`, so a kind outside `default`'s reach was refused on the wire;
now each answers the frame its TypeScript counterpart emits
(`src/handlers/event-strategies/*-event-strategy.ts`). Filling a body exposed four
decisions the code cannot show on its face: two of the arms call a service the relay does
not own, one arm cannot be honest without a binary-format parser, one storage outcome the
capture catches by string has no Rust variant, and one hex check disagrees with the other
four on purpose.

This ADR records those, and the census total that moved with them. Each heading is
greppable.

## The web-of-trust graph is the relay's own trait

`contact_list` replaces a pubkey's follows (`contact-list-event-strategy.ts:36`) and
`report` asks a reporter's distance (`report-event-strategy.ts:53`). The graph is a
service (`nostream-services`' `wot_graph_service`, #866), and `nostream-relay` takes no
dependency on that crate: `src/wot.rs:25` declares `WotGraph` beside `limits::Limiter`,
which is the file's existing precedent for a service the relay needs and does not own. The
instance follows the same precedent: the composition root picks it, `Relay::new` takes it,
and `HandlerContext` carries it beside `limits` — not in `Stores`, which holds storage
traits only.

The shapes rejected:

- **Depend on `nostream-services`.** The service is a Phase 1 stub, so the arms would be
  written against a signature that has not been designed, and every relay test would link a
  crate the wire does not otherwise touch.
- **Read the graph out of storage.** The capture's graph is in-memory state behind its
  service; a repository trait here would fix an on-disk shape #866 has not chosen.
- **Inline the whole graph in the relay.** That is #866's work, not this job's.

`UnavailableWotGraph` (`src/unavailable.rs:41-66`) is the capture's *disabled* graph, not a
failing one: a follow-list update touches nothing and `get_distance` answers `None`, which
`report` stores as an unweighted row — a report from a relay with no graph is still a
report. `Err` is reserved for a wired implementation's genuine failure (a rebuild that
could not complete), and both arms log that and carry on, as the capture's `try`/`catch`
does. Saying `Err` for "no graph" would have dropped every report row on a daemon without
#866 while the event itself was already stored — unrecoverable, since a resend hits the
duplicate path. The other consequence is recorded where it bites: ADR 0004's adaptive-PoW
section says a missing distance is charged in full.

## The OpenTimestamps parser lives in core

The `timestamp` arm's seven structural rules are cheap; its proof is not. A kind-1040 event
whose proof does not commit to the event it names is worse than useless to a client, so the
arm cannot answer `OK true` without parsing the `.ots` bytes, and it cannot answer a
reason string it did not compute — the capture's five `validateOtsProof` refusals are the
text of the client's `OK` frame.

The parser is `nostream-core::nip03` (`src/nip03.rs`), not a relay module, because the
capture's verifier is `src/utils/nip03.ts` — core's declared surface — and because the
relay's `Cargo.toml` names no binary parser. `parse_ots_file` is structural by
construction: a relay cannot verify an attestation against the chain (`src/nip03.rs:3-6`),
so it validates the magic header, the LEB128 lengths, the tree, and the three
relay-observable requirements (sha256 file hash, digest equal to the attested id, at least
one Bitcoin attestation), and every rejection is the capture's reason verbatim.

**`OtsSummary::digest` is `Vec<u8>`, not `[u8; 32]`** (`src/nip03.rs:108`), which departs
from this job's spec. A sha1 or ripemd160 proof carries a 20-byte digest, and the capture
reads the file hash op's own length before the digest. Refusing a short digest at parse time
would move one of `validateOtsProof`'s five rules into the parser and change the reason the
client sees from `ots proof must use sha256 file hash op (got sha1)` to a parse error; two
census cases pin that reason. The digest is compared as a slice
(`src/nip03.rs:199`), so the sha256 rule stays where the capture puts it.

## A report's weight is a method on the enum

The `real` column wants a number (`NewReport::weight: f32`); the port's decision wants a
classification (a moderator's report is actionable whatever the distance, an unreachable
reporter's never is). `ReportWeight::weight` (`src/report_scoring.rs:22`) keeps both: the
enum `score_reporter` returns, and the f32 the row stores — `1.0` for `Trusted`, `0.0` for
`Unweighted`, and `2^-(distance-1)` for `Weighted`, with `distance <= 1` flat at `1.0`. One
representation would have lost the actionable bit; `Trusted` and `Weighted { distance: 1 }`
both weigh `1.0` and only the first marks the target hidden.

f32 underflows for a very large distance, which the capture's JS does not; the method
returns `0.0` from `hops >= 150` rather than depending on `powi`'s own underflow, and no
census case reaches it.

## `StorageError::DuplicateEvent`, and no backend text on the wire

`replaceable` and `contact_list` catch the capture's duplicate insert by matching the text
`duplicate key value violates unique constraint "events_event_id_unique"`
(`replaceable-event-strategy.ts:27`, `contact-list-event-strategy.ts:45`) and answer
`rejected: event already exists`. `StorageError` had no such variant, and the storage
crate's own doc forbids forwarding a driver's message to a caller
(`crates/nostream-storage/src/error.rs:20-23`).

So the variant is new (`src/error.rs:18`, Display "the event id already exists"), produced
by the Postgres backend from SQLSTATE `23505` *and* the constraint name
(`postgres/events.rs:118`), and by the in-memory double on demand — which is how the two
`rejected:` census cases are tested without a database. Every other storage failure passes
through unchanged and leaves `execute` as an `Err`, answered by the handler as
`error: unable to process event`: a store failure is not a policy string about the
publisher, and the two census titles that describe the capture's
`error: <driver message>` are carried by asserting that `Err` (spec Assumption 3).

## The `/i` asymmetry is reproduced, not fixed

`src/utils/nip56.ts:16` tests a 64-hex value as `/^[0-9a-f]{64}$/i`, so the report arm
accepts uppercase hex. The four validators that refuse uppercase are lowercase-only:
`delete-event-strategy.ts:22`, `gift-wrap-event-strategy.ts:49`,
`group-event-strategy.ts:50` and `timestamp-event-strategy.ts:70`. The port keeps both
sides: `nip56::extract_report_targets` hex-decodes either case
(`crates/nostream-core/src/nip56.rs:165`), and the four arms parse with the types that own
the rule — `EventId`/`Pubkey` for the delete, gift-wrap and timestamp tags, and
`strategies::is_lowercase_hex64` (`src/strategies/mod.rs:185`) only for the group arm's
`h` tag, which has no core type to parse into.

Normalising either way was rejected. "Lowercase everywhere" would refuse a report the
capture accepts; "insensitive everywhere" would accept a delete, gift wrap, group event or
timestamp the capture refuses — a wire-visible change to which events a relay takes, decided
by a port's taste. The census pins the lowercase side with two explicit cases ("rejects when
the group id contains uppercase hex chars", "rejects upper-case hex in the e tag") and the
core tests pin the report side (`nip56::tests::uppercase_hex_names_the_same_target`). This
is the one place where the same question has two answers in one relay; it is the capture's
answer, and a future decision to change it belongs to a spec, not to a port.

## The census grew to 658

`tests/fixtures/ts-cases.json` is the 658 case titles of the 36 in-scope spec files
(`tests/capture/gen-ts-cases.mjs`, which refuses to write when a file's case count
disagrees with its table), and `tests/fixtures/ts-case-map.json` maps 612 of them across 200
rows to 182 live Rust tests. The fourteen strategy files contribute 101 cases: 97 are
carried one-to-one by `tests/strategies.rs`, whose names and titles are the map's rows, and
four are exempt with a job-naming reason because the admission cache they assert does not
exist in the port (`crates/nostream-storage/src/cache.rs` is a `pub(crate)` stub). Two
unmapped tests carry the success halves those exemptions would otherwise leave unobserved:
the join admits and answers with the welcome, the leave revokes.

ADR 0004's census section is corrected to the same figures.
