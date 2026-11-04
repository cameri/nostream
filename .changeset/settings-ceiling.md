---
---

fix(config): give both bounds a ceiling in the settings validator

#996 put the zero of `network.frameMemoryBudgetBytes` and
`limits.connection.maxConnectionsPerIp` in `validate_document` and left the ceiling in
`nostream-relay`, so `nostreamd --check` blessed `1099511627776` and `1099511627777` with the same
`settings valid: 0 issues` and the same exit 0 while the relay quietly ran the second one on its
compiled default. The ceiling is now a validator issue like the zero — one rule per key, each
naming the value the file states and the ceiling it crossed — so both doors count it, exit 2 on it,
and `load` discards the document instead of silently substituting one number.

The two ceilings are two numbers: 1 TiB for the budget, because `FrameBudget::admit` adds the
accounted bytes unchecked after a `saturating_sub` guard, and 2^40 / 2^23 = 2^17 = 131 072 sockets
for the cap, the sockets whose full 8 MiB queues exhaust that budget. `MAX_SETTING_BOUND`,
`in_range`, `BoundRefusal`, `refused_bounds`, `bound_refusal`, `refusal_message` and the start-up
`warn!` are deleted, `RelayConfig::from_settings` takes every present leaf as written, and the
`nostream-cli` → `nostream-relay` dependency edge goes with them. The guided catalogue's two entries
carry the same ceilings through a new `SafeNonNegativeIntegerAtMost` validator. ADR 0009 records
the decision and marks the passages of ADR 0008 it supersedes.

The TypeScript tree is untouched: no `src/` or `test/` file changes, so the published package has
no user-visible change.
