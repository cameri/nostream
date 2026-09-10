---
"nostream": minor
---

feat: add WoT-weighted NIP-56 content reporting

Accepts and stores kind-1984 report events, weighting each report by the reporter's WoT distance
from `wot.seedPubkey` (full weight for a direct follow, halving each additional hop, zero for a
pubkey outside the trust graph). Reports from a `nip56.trustedModerators` pubkey always get maximum
weight and are flagged actionable, ready for a future management-API surface to act on; every other
report is stored for manual review only. Disabled by default (`nip56.enabled: false`).
