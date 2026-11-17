---
---

fix(relay): dedupe and cap a deletion request's e ids (#1090)

A kind-5 request's `e` arm handed every parseable id to `delete_by_pubkey_and_ids` with no bound — about 7 180 at the shipped `maxPayloadSize`, including repeats. The ids are now deduplicated and capped at 100 distinct per request, refused with `OK false` before anything is deleted or stored, exactly as the `a` arm's address cap refuses. The number is derived from a measured per-id cost next to the address cap's arithmetic. Rust-only, so this changeset is empty on purpose: no published package changes.
