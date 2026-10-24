---
---

feat(relay): answer a real client over the wire, with the capture's rate limits

`nostream-relay` now serves the wire surface job 008 specified: connection control,
`EVENT` ingestion through the strategy and limiter pipeline, `REQ`/`CLOSE` with
streaming `EVENT` and `EOSE`, NIP-42 `AUTH` with restricted reads, `COUNT`, and the
`OK`/`NOTICE`/`CLOSED` replies the capture sends. The limiter keeps four per-level
stores with lapse-preferring eviction and a store-owned sweep, so a refused level
reopens within one window plus one sweep interval.

Parity is measured rather than asserted. `ts_case_parity` runs 462 cases of the
TypeScript census against the Rust handlers; `wire_parity` replays 16 captured
sessions, 78 steps, and compares frames byte for byte with one declared tolerance.

The TypeScript tree is untouched: no `src/` or `test/` file changes, so the published
package has no user-visible change. Decisions are recorded in
`docs/rewrite/decisions/0004-wire-transport.md`.
