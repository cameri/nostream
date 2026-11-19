//! `nostream-mcp` owns the admin MCP server: the tool router, the four slice-1 tools, the
//! credential gate and the audit sink.
//!
//! It owns no transport and no socket. `nostreamd --mcp-stdio` serves this server on
//! stdin/stdout through `rmcp`'s `transport-io`, in the daemon's own process, so the tools read
//! the same [`AdminState`](nostream_admin::AdminState) the HTTP console does: the same session
//! credential, the same `<config>/admin-audit.jsonl` and the same repository bundle (D9, D13).
//!
//! **Deliberately not owned here** — a reader should be able to tell an omission from a gap:
//!
//! - the runtime, the signals, the socket and the stdio mode — `nostreamd`;
//! - the admin state, the session token, the audit file and the settings write path —
//!   `nostream-admin` (used here, not re-implemented);
//! - the settings merge, validation, redaction and the guided catalogue — `nostream-config`;
//! - the event store and the repositories — `nostream-storage`;
//! - every tool family outside slice 1: `relay_status`, `delete_event`, `user_admin`,
//!   `invoices_*`, `reports_*` and `maintenance_*` are later slices of #1183.

mod error;
mod server;

pub use error::McpError;
pub use server::{
    AdminMcp, GetEventArgs, INTERNAL_SERVER_ERROR, ListEventsArgs, MCP_SERVER_NAME, NOT_FOUND,
    SettingsSetArgs, TOOL_GET_EVENT, TOOL_LIST_EVENTS, TOOL_SETTINGS_GET, TOOL_SETTINGS_SET,
    UNAUTHORIZED, audit_action,
};
