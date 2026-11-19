//! `nostream-mcp` owns the admin MCP server: the tool router, the four slice-1 tools, the
//! credential gate and the audit sink.
//!
//! It owns no transport and no socket. `nostreamd --mcp-stdio` serves this server on
//! stdin/stdout through `rmcp`'s `transport-io`, in a process of its own: the mode composes its
//! own [`AdminState`](nostream_admin::AdminState) over the same config directory, so the tools
//! read the same session credential, the same `<config>/admin-audit.jsonl` and the same
//! repository bundle (D9, D13). The two modes are alternatives — a daemon serving the console,
//! or a process serving the pipe — and running both against one config directory is outside D9:
//! the audit file and the settings write each assume one writer per configuration.
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
    AdminMcp, GetEventArgs, INTERNAL_SERVER_ERROR, ListEventsArgs, MAX_FILTER_TERMS, MAX_PAGE_ROWS,
    MCP_INSTRUCTIONS, MCP_SERVER_NAME, NOT_FOUND, SettingsSetArgs, TOOL_ARGUMENTS, TOOL_GET_EVENT,
    TOOL_LIST_EVENTS, TOOL_SETTINGS_GET, TOOL_SETTINGS_SET, UNAUTHORIZED, arguments_parse,
    audit_action,
};
