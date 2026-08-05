---
"nostream": minor
---

Add NIP-43 join/leave request event strategies (kinds 28934/28936) with NIP-42 auth enforcement, created_at freshness validation, invite code claiming, and admission management. When `nip43.enabled` is set, publishing is restricted to admitted members even without payments enabled, and NIP-43 is advertised in the NIP-11 document (hidden when disabled). Join/leave update the admission cache so membership changes take effect immediately.
