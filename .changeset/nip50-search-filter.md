---
---

feat(storage): answer NIP-50 from a scan-time token filter

The LMDB backend applies the token rule to `Filter::search` during the scan it already
performs — no index, no rank, no store migration — and declares `SearchRule::TokenTerms`
with the NIP-50 gate on. The parity arm replays fixture entry 21:
`LMDB_PARITY_COMPLETE replayed=114 excluded=48,50,112,115`. No published package changes:
a Rust-only change touches no release set.
