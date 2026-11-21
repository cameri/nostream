---
---

feat(mcp): `relay_status`, slice 2 — the published status document and the NIP-11 builder

A fifth MCP tool answers the relay's status: the software version, the relay process's uptime,
its live connection count, its worker rows and the NIP-11 document it advertises. The facts only
the relay process can know are not invented by the answering process — `nostreamd` publishes
`<config>/relay-status.json` every 5 s (a 30 s freshness bound, written through a sibling `.tmp`
and a rename so no reader sees a half-written document) and the tool reads it per call. When the
document is absent, unreadable or older than the bound those values are `null` with a reason
naming the file, never `0`: a zero would read as "nothing is connected". `ConnectionCap` gains
`live_total()`, the socket count the document carries. The document also carries `relayPubkey`,
the key the daemon signs with, so the tool's NIP-11 `self` is the relay's identity rather than one
the answering process derived from its own environment.

The NIP-11 document is built by `nostream_relay::nip11` from the settings, and every key's
presence is decided there: `supported_nip_extensions`, `supported_mips`, `payments_url`,
`peering`, `limitation.min_prefix`, `limitation.max_event_tags` and `fees.subscription` are
dropped with their reasons, `supported_nips` loses 43/50 when their switches are off and 77
always, and `restricted_writes` folds the arms the event handler enforces. Nothing serves it
over HTTP and `nostream-cli info` is unchanged. The decisions are ADR 0016 D1–D7, which closes
`docs/rewrite/nip-parity.md` item 11.

Rust only: no published package changes, so this entry carries no version bump.
