---
---

feat(config): expose the frame budget and the per-IP cap as settings keys

The two bounds #959 added were `RelayConfig` fields only:
"pub frame_memory_budget_bytes: usize," (`crates/nostream-relay/src/relay.rs:66`) and
"pub max_connections_per_ip: usize," (`crates/nostream-relay/src/relay.rs:70`). A running
daemon could not change either number without a rebuild, which is what #989 is about.

Both are now settings the operator writes:

- `network.frameMemoryBudgetBytes` in `resources/default-settings.yaml` — the byte count every
  socket's queued outbound payload is counted against.
- `limits.connection.maxConnectionsPerIp` in `resources/default-settings.yaml` — the live
  sockets one source address may hold at once.

`RelayConfig::from_settings` reads both leaves, in the one place either is interpreted, and falls
back to the compiled default when a leaf is absent, zero, or above the ceiling that keeps an
operator's number out of the frame accounting:
"    value > 0 && value <= MAX_SETTING_BOUND as u64" (`crates/nostream-relay/src/relay.rs:115`). The
daemon builds its config through it: "let mut relay_config = RelayConfig::from_settings(&settings);"
(`crates/nostreamd/src/main.rs:110`), keeping its one environment read. A value it replaces is not
silent: the constructor warns with the setting, the value, the ceiling and the default —
"            \"a bound above its ceiling runs with its default\"" (`crates/nostream-relay/src/relay.rs:191`)
— and `nostreamd --check` and `nostream-cli config validate` print the same sentences before a relay
exists, from one place: "pub fn refusal_message(setting: &str, reason: BoundRefusal) -> String {"
(`crates/nostream-relay/src/relay.rs:169`).

The defaults document's values equal `RelayConfig::default()`'s, and a test in
`crates/nostream-relay/tests/config_defaults.rs` holds the two together. No validator rule is
added: the document is the validator's schema, so the two keys alone make an operator's file
valid. See ADR 0008 for what a zero means and why.

The TypeScript tree is untouched: no `src/` or `test/` file changes, so the published package
has no user-visible change.
