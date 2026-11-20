//! `nostream-mcp` owns the admin MCP server: the tool router, the four slice-1 tools, the
//! credential and its scopes, and the audit sink.
//!
//! It owns no transport and no socket. `nostreamd --mcp-stdio` serves this server on
//! stdin/stdout through `rmcp`'s `transport-io`, in a process of its own: the mode composes its
//! own [`AdminState`](nostream_admin::AdminState) over the same config directory, so the tools
//! read the same settings and append to the same `<config>/admin-audit.jsonl` the console does,
//! over a repository bundle of the mode's own (D7, D18) — the daemon's bundle is composed in
//! `crates/nostreamd/src/main.rs`, this mode's in its `mcp_stdio` module, and the two are
//! independent `Arc`s that the store-wiring change has to move together. The two modes are
//! alternatives — a daemon serving the console, or a process serving the pipe — and running both
//! against one config directory is outside D9: the audit file and the settings write each assume
//! one writer per configuration.
//!
//! **The credential is this door's own** ([`Credential`]): a scoped token document delivered by
//! file or descriptor (D19), never the console's session token and never an environment variable.
//! The file form is re-read on every call, so rewriting or deleting it is the revocation; the
//! descriptor form is read once at start and lives as long as the process.
//!
//! **Deliberately not owned here** — a reader should be able to tell an omission from a gap:
//!
//! - the runtime, the signals, the socket and the stdio mode — `nostreamd`;
//! - the admin state, the console's session token, the audit file and the settings write path —
//!   `nostream-admin` (used here, not re-implemented);
//! - the settings merge, validation, redaction and the guided catalogue — `nostream-config`;
//! - the event store and the repositories — `nostream-storage`;
//! - every tool family outside slice 1: `relay_status`, `delete_event`, `user_admin`,
//!   `invoices_*`, `reports_*` and `maintenance_*` are later slices of #1183.

mod credential;
mod error;
mod server;

pub use credential::{
    ACCEPTED_SCOPES, Credential, MAX_TOKEN_DOCUMENT_BYTES, SCOPE_WRITE, Scopes, TOKEN_FILE_MODE,
};
pub use error::McpError;
pub use server::{
    AUDIT_DENIED, AdminMcp, FORBIDDEN, GetEventArgs, ListEventsArgs, MAX_FILTER_TERMS,
    MAX_ROWS_PER_PAGE, MCP_INSTRUCTIONS, MCP_SERVER_NAME, NOT_FOUND, Requires, SettingsSetArgs,
    TOOL_GET_EVENT, TOOL_LIST_EVENTS, TOOL_SETTINGS_GET, TOOL_SETTINGS_SET, TOOLS, Tool,
    UNAUTHORIZED, arguments_parse, audit_action, required_scope,
};
