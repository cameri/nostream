---
---

feat(relay): fill the fourteen event strategies, with a real OTS verifier behind them

`nostream-relay` now answers every kind its selector routes: contact list, delete, DVM job
request, ephemeral, gift wrap, group, invite request, join request, leave request,
parameterized replaceable, replaceable, report, timestamp and vanish each emit the frame
their `src/handlers/event-strategies/` counterpart does — the same `OK` text, the same
broadcast, and the same best-effort block after the store. Two seams carry what the arms
call and the relay does not own: a `WotGraph` trait (`src/wot.rs`) for the follow-list and
distance calls, and `nostream_core::nip03`'s OpenTimestamps parser for kind-1040 proofs,
whose reason strings reach the client verbatim. `nostream-core` gains NIP-56 target
extraction, report scoring and the NIP-43 request helpers; `nostream-storage` gains
`StorageError::DuplicateEvent`, produced from `23505` on `events_event_id_unique`, so the
two catching arms answer `rejected: event already exists` without a driver's message ever
reaching a client.

Parity is measured rather than asserted. The census grew from 557 to 658 cases (36 spec
files, 612 mapped across 200 rows to 182 live Rust tests, 46 exempt with the job that owns
them), and the fourteen files' 101 cases are carried by the new `tests/strategies.rs`
target's 99 tests. Decisions are recorded in
`docs/rewrite/decisions/0006-event-strategies.md`.
