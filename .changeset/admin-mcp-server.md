---
---

feat(admin): the admin MCP server, slice 1 — four tools over stdio

A new Rust crate serves `settings_get`, `settings_set`, `list_events` and
`get_event` on stdin/stdout through `rmcp`, served by `nostreamd --mcp-stdio` as a process
of its own over the same config directory. Every call is decided by a scoped token document
the mode is handed by file (`--admin-token-file`, a regular file of at most 4 KiB with no group
or other permission — 0600 is the usual mode — re-read on every call so deleting or rewriting it
is the revocation) or by an inherited descriptor (`--admin-token-fd`, held to the same rules and
read once at start); `settings_set` needs the document's `write` scope, and a denied write is
refused and recorded as `mcp.denied`. A console session token no longer authenticates the mode and
`NOSTREAM_ADMIN_TOKEN` is retired: setting it refuses the start. Executed calls are audited to
`admin-audit.jsonl` under one `mcp.<tool>` action; those names are recorded as ADR 0014 D18 and
the credential as D19.

Rust only: no published package changes, so this entry carries no version bump. The
operator-facing carriers are the mode's `--help`, `CONFIGURATION.md` and ADR 0014 D19.
