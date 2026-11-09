---
---

feat(core): the audited NIP advertisement, NIP-67 EOSE hints, NIP-44's extended length and NIP-09 `a` tags

No published package changes: the work is Rust-only (`crates/`), and no `src/` or `test/`
file moves. `SUPPORTED_NIPS` becomes the Phase 0 audit's 34-id set; the relay's `EOSE`
may carry NIP-67's hint array; NIP-44 gains the six-byte length prefix and the format's
2³²−1 ceiling; and a NIP-09 `a` tag now deletes the author's addressable event.
