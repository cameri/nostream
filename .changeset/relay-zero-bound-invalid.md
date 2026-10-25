---
---

fix(config): refuse a zero frame-memory budget or per-IP cap in the validator

#989 gave `network.frameMemoryBudgetBytes` and `limits.connection.maxConnectionsPerIp` a
meaning for `0` — *use the compiled default* — which contradicts what ADR 0008 already said
about a zero: "A zero budget or a zero cap is a literal the operator wrote"
(`docs/rewrite/decisions/0008-frame-memory-budget.md:369`). It is also a fourth meaning for
the same numeral in one repository, where `limits.client.subscription` reads a zero as
*disabled* and `limits.event.pow.targetEventsPerSecond` reads it as *invalid*.

A stated `0` is now an issue, in the shape the validator already uses for the adaptive-pow
numbers: `network.frameMemoryBudgetBytes: frameMemoryBudgetBytes must be greater than 0` and
`limits.connection.maxConnectionsPerIp: maxConnectionsPerIp must be greater than 0`
(`crates/nostream-config/src/validate.rs`). Both doors report it and exit 2, so the daemon
continues on the shipped defaults and the operator learns which key to fix — where a fallback
turned the typo into a relay that silently budgeted 256 MiB.

`RelayConfig::from_settings` therefore takes a present leaf as written and keeps `in_range` as
the ceiling question alone: "pub fn in_range(value: u64) -> bool {" now spells
"    value <= MAX_SETTING_BOUND as u64" (`crates/nostream-relay/src/relay.rs:115`). The zero
variant of `BoundRefusal`, its refusal sentence and its start-up `warn!` arm are gone with it;
an absent leaf still means the compiled default and an over-ceiling value still falls back with
the same two sentences as before.

The TypeScript tree is untouched: no `src/` or `test/` file changes, so the published package
has no user-visible change.
