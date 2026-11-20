---
---

feat(admin): the admin MCP server, slice 1 — four tools over stdio

A new Rust crate serves `settings_get`, `settings_set`, `list_events` and
`get_event` on stdin/stdout through `rmcp`, served by `nostreamd --mcp-stdio` as a process
of its own over the same config directory. Every call is gated by the console's own session token and
audited to `admin-audit.jsonl` under one `mcp.<tool>` action; the four names are
recorded as ADR 0014 D18.

Rust only: no published package changes, so this changeset is deliberately empty.
