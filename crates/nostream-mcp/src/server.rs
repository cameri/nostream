//! The MCP server: the seven tools, the credential gate and the audit sink.
//!
//! Every tool is a thin handler over a seam that already exists — `AdminState` for the settings,
//! `EventRepository` for the events — and nothing here knows what an HTTP status is (R3). The
//! gate and the audit line live in [`ServerHandler::call_tool`], at dispatch: a call the
//! credential refuses reaches no tool and writes nothing (R8), a call its scopes deny writes the
//! one `mcp.denied` line that records the denial (R28), and a call that reaches a tool has its
//! `mcp.<tool>` line written before the tool's own work, so the file's order is the dispatch
//! order (R9).

use std::borrow::Cow;
use std::sync::Arc;

use nostream_admin::AdminState;
use nostream_admin::controllers::admin_json_body_middleware::settings_patch;
use nostream_admin::controllers::patch_settings::{self, SettingsWrite};
use nostream_admin::utils::status;
use nostream_core::{EventId, Filter, Kind};
use nostream_relay::nip11;
use nostream_storage::repositories::{EventRecord, collect_page, collect_records};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::tool::ToolCallContext;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ServerCapabilities, ServerConfig,
};
use rmcp::schemars::{self, JsonSchema, Schema, SchemaGenerator, json_schema};
use rmcp::service::RequestContext;
use rmcp::{RoleServer, ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::credential::{Credential, SCOPE_WRITE, Scopes};
use crate::error::McpError;

/// The server name `initialize` reports: the server, not the SDK, which would name `rmcp` (R6).
pub const MCP_SERVER_NAME: &str = "nostream";

/// What `initialize`'s `instructions` carries: the route to a working call.
///
/// The refusals the gate answers name a symptom, not its cause, and nothing else on the surface
/// says what a caller needs — a client that reads `Not Found` for a tool it was just told exists
/// has nowhere to look. This is that place, and it is additive: the refusal texts stay exactly as
/// the console's layers word them.
pub const MCP_INSTRUCTIONS: &str = "\
The nostream admin MCP server. Every call is decided by the scoped token document the mode was \
started with — `--admin-token-file <path>` or `--admin-token-fd <n>`, exactly one, its shape \
{\"scopes\": [\"write\"]}: the document's presence authorises `settings_get`, `list_events`, \
`get_event` and `relay_status`, and the \"write\" scope authorises `settings_set`, \
`delete_event` and `reports_action` (else the call \
is `Forbidden`). \
`admin.enabled` must be true in the settings, or every call answers `Not Found`; a document \
that cannot be read answers `Unauthorized`. Each executed call appends one `mcp.<tool>` line to \
`<config>/admin-audit.jsonl`, and a call the document's scopes deny appends one `mcp.denied` \
line.";

/// The tool names this surface registers (R5). Each is also its audit action's suffix (R9).
pub const TOOL_SETTINGS_GET: &str = "settings_get";
pub const TOOL_SETTINGS_SET: &str = "settings_set";
pub const TOOL_LIST_EVENTS: &str = "list_events";
pub const TOOL_GET_EVENT: &str = "get_event";
pub const TOOL_RELAY_STATUS: &str = "relay_status";
pub const TOOL_DELETE_EVENT: &str = "delete_event";
pub const TOOL_REPORTS_ACTION: &str = "reports_action";

/// What a delete call did, as the payload's `outcome` (R3, R4): this call marked the row
/// deleted.
pub const OUTCOME_DELETED: &str = "deleted";

/// The row already carried `deleted_at`, so the store skipped it and this call changed nothing.
pub const OUTCOME_ALREADY_DELETED: &str = "already_deleted";

/// The store skipped a live row for the only other reason it has: kind 62 is never deleted.
pub const OUTCOME_NOT_DELETEABLE: &str = "not_deleteable";

/// No row carries the id this call named.
pub const OUTCOME_NOT_FOUND: &str = "not_found";

/// The most `ids` or `authors` criteria one call may carry.
///
/// Each criterion is its own index range, and an `ids` range is not in time order, so a call's
/// visit is bounded by this count rather than by the store — and this surface has no rate
/// limit (the spec removes it by design), so the count is the only bound there is.
pub const MAX_FILTER_TERMS: usize = 64;

/// The most rows a `list_events` page may hold: the store's own ascending page
/// ([`nostream_storage::DEFAULT_PAGE_ROWS`]), which is what a filter carrying no `limit`
/// materialises. A larger page would need the store's limited iterator, which returns the
/// newest rows rather than the first.
///
/// It is not `nostream_storage::MAX_PAGE_ROWS`, the relay's 5,000-row clamp: this is the page a
/// read materialises, which is the number a backend opens with.
pub const MAX_ROWS_PER_PAGE: u64 = nostream_storage::DEFAULT_PAGE_ROWS;

/// The refusal for a credential whose document is absent, unreadable or no longer a document this
/// door accepts — the HTTP gate's `401`.
pub const UNAUTHORIZED: &str = "Unauthorized";

/// The refusal for a call the credential's scopes do not cover — the HTTP gate's `403`. It is the
/// one refusal that describes a call the door authenticated (R28), so it is the one that is
/// written down.
pub const FORBIDDEN: &str = "Forbidden";

/// The refusal for a surface `admin.enabled` does not turn on — the console's `404`.
pub const NOT_FOUND: &str = "Not Found";

/// The audit action a call its credential's scopes denied records (R28).
pub const AUDIT_DENIED: &str = "mcp.denied";

/// The audit action one dispatched call records: `mcp.<tool>` (R9).
pub fn audit_action(tool: &str) -> String {
    format!("mcp.{tool}")
}

/// The scope a call needs from the document (R28).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Requires {
    /// Reading: the grant every accepted document carries, so no scope names it and none is
    /// asked for at dispatch. The four read tools say this in the table rather than leaving
    /// the column empty.
    Read,
    /// [`SCOPE_WRITE`]: the one scope a document may add, and the right to call `settings_set`.
    Write,
}

/// One tool the router registers: its name, the check that says whether the router can
/// deserialise a call's arguments (R9), and the scope the call needs (R28).
///
/// The two facts are one row because they are one decision: a `#[tool]` method added to the
/// router has to appear here once, and both the audit line and the gate read the row it lands
/// in.
#[derive(Debug, Clone, Copy)]
pub struct Tool {
    /// The name `tools/list` publishes, which is also its audit action's suffix.
    pub name: &'static str,
    /// Whether the router can deserialise a call's arguments: the audit line's condition.
    pub parses: ArgumentsCheck,
    /// What the call needs from the document.
    pub needs: Requires,
}

/// The router's own answer for a name it does not register, word for word
/// (`ToolRouter::call`, `rmcp`): the door answers an unknown name before the scope decision so a
/// rowless tool is refused rather than dispatched, and it must be the same refusal the router
/// would have given.
const TOOL_NOT_FOUND: &str = "tool not found";

/// The scope a call needs (R28).
///
/// A name the table does not carry needs [`Requires::Write`], not [`Requires::Read`]: a name the
/// table does not carry is the case to fail closed on, and the safe direction is the other way
/// round from the one that reads well — a miss there would let a document that grants nothing but
/// reads call a write. [`ServerHandler::call_tool`] refuses such a name before it asks this
/// question, with the router's own `tool not found`, so the default is the answer to a total
/// function rather than a path a call travels; `every_registered_tool_has_a_table_row`
/// (`tests/audit.rs`) is what keeps the table and the router one list.
pub fn required_scope(tool: &str) -> Requires {
    row(tool).map_or(Requires::Write, |entry| entry.needs)
}

/// Whether the router can deserialise a call's arguments: the same type its handler takes.
type ArgumentsCheck = fn(Option<&Map<String, Value>>) -> bool;

/// The table: every tool the router registers, once, with both dispatch-time facts (R9, R28).
///
/// The rule each [`Tool::parses`] keeps is **no stricter than the router's own deserialisation**,
/// not "the shape the `inputSchema` states". [`ServerHandler::call_tool`] writes the line when
/// the check answers `true` and then dispatches unconditionally, so a check that refused a call
/// the router runs would execute it unaudited — R9's guarantee failing open. The check exists to
/// write the line *before* the handler, never to refuse a call; `settings_set`'s is therefore
/// deliberately vacuous, because its arguments are a raw map and its `inputSchema` is the half
/// that refuses.
///
/// The dispatch path looks a name up here and has no "everything else" arm: a name the table does
/// not carry is refused with the router's own `-32602 tool not found`, before the scope decision
/// and before any line is written, so a tool added to the router without a row is unreachable
/// rather than unaudited — and cannot execute ungated either. `every_registered_tool_has_a_table_row`
/// reads the router's own list, so the two are one list by case as well as by shape, and this
/// refusal is the fallback for the day they are not.
pub const TOOLS: &[Tool] = &[
    Tool {
        name: TOOL_SETTINGS_GET,
        parses: accepts_any_arguments,
        needs: Requires::Read,
    },
    Tool {
        name: TOOL_SETTINGS_SET,
        parses: settings_set_parses,
        needs: Requires::Write,
    },
    Tool {
        name: TOOL_LIST_EVENTS,
        parses: list_events_parse,
        needs: Requires::Read,
    },
    Tool {
        name: TOOL_GET_EVENT,
        parses: get_event_parses,
        needs: Requires::Read,
    },
    Tool {
        name: TOOL_RELAY_STATUS,
        parses: accepts_any_arguments,
        needs: Requires::Read,
    },
    Tool {
        name: TOOL_DELETE_EVENT,
        parses: delete_event_parses,
        needs: Requires::Write,
    },
    Tool {
        name: TOOL_REPORTS_ACTION,
        parses: reports_action_parses,
        needs: Requires::Write,
    },
];

/// `tool`'s row; `None` when the table does not name it.
fn row(tool: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|entry| entry.name == tool)
}

/// `tool`'s row, when the router dispatches it too: the door serves a name the table carries
/// **and** the router's own map holds (D18).
///
/// The two lists are one by case — `every_registered_tool_has_a_table_row`, and the equality
/// `tests/audit.rs` and `tests/auth.rs` assert — but a call is dispatched from the router's map,
/// so that is the membership the refusal asks as well: a row whose `#[tool]` method is absent is
/// refused exactly as a name the table does not carry is, rather than audited for a call that
/// reaches no tool.
fn served(router: &ToolRouter<AdminMcp>, tool: &str) -> Option<&'static Tool> {
    row(tool).filter(|entry| router.has_route(entry.name))
}

/// Whether `tool`'s arguments parse; `None` when the table does not name it.
///
/// `call_tool` refuses such a name before it asks, so the `None` is this function's contract and
/// not a branch a call reaches.
pub fn arguments_parse(tool: &str, arguments: Option<&Map<String, Value>>) -> Option<bool> {
    row(tool).map(|entry| (entry.parses)(arguments))
}

/// `settings_get` takes no parameters, so the router deserialises nothing for it.
fn accepts_any_arguments(_: Option<&Map<String, Value>>) -> bool {
    true
}

fn settings_set_parses(arguments: Option<&Map<String, Value>>) -> bool {
    serde_json::from_value::<SettingsSetArgs>(arguments_value(arguments)).is_ok()
}

fn list_events_parse(arguments: Option<&Map<String, Value>>) -> bool {
    serde_json::from_value::<ListEventsArgs>(arguments_value(arguments)).is_ok()
}

fn get_event_parses(arguments: Option<&Map<String, Value>>) -> bool {
    serde_json::from_value::<GetEventArgs>(arguments_value(arguments)).is_ok()
}

fn delete_event_parses(arguments: Option<&Map<String, Value>>) -> bool {
    serde_json::from_value::<DeleteEventArgs>(arguments_value(arguments)).is_ok()
}

fn reports_action_parses(arguments: Option<&Map<String, Value>>) -> bool {
    serde_json::from_value::<ReportsActionArgs>(arguments_value(arguments)).is_ok()
}

fn arguments_value(arguments: Option<&Map<String, Value>>) -> Value {
    Value::Object(arguments.cloned().unwrap_or_default())
}

/// The `list_events` criteria: each maps to one [`Filter`] field (R15).
///
/// The set is closed. Every field is optional, so serde would otherwise drop a mistyped name —
/// `kind` for `kinds` is one character of plural away — and answer every row as if no criterion
/// had been given. `deny_unknown_fields` makes that an argument error and publishes
/// `additionalProperties: false`, which is the same rule a validating client reads.
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListEventsArgs {
    /// Kinds to select; absent selects every kind.
    pub kinds: Option<Vec<u64>>,
    /// Author pubkey hex prefixes, 4 to 64 characters each in either case; at most 64 per
    /// call. A criterion the wire would refuse is an error, not a narrower read.
    pub authors: Option<Vec<String>>,
    /// Event id hex prefixes, 4 to 64 characters each in either case; at most 64 per call.
    pub ids: Option<Vec<String>>,
    /// Events created at or after this unix second.
    pub since: Option<i64>,
    /// Events created at or before this unix second.
    pub until: Option<i64>,
    /// Page size: 1 to 500 rows, and they are the first rows in the payload's order; absent
    /// uses 500, the store's own page.
    #[schemars(range(min = 1, max = 500))]
    pub limit: Option<u64>,
}

/// The `get_event` arguments, and no others: an unknown key is an argument error, as it is for
/// [`ListEventsArgs`].
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GetEventArgs {
    /// The event's 64-character hex id, in either case.
    pub id: String,
}

/// The delete tool's arguments: one id and nothing else (R2).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteEventArgs {
    /// The event's hex id, in either case; a prefix shorter than 64 characters is refused and deletes nothing
    pub id: String,
}

/// The report action's arguments: one report event's id and the decision to give it (R12).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReportsActionArgs {
    /// The report's own kind-1984 event id, exactly 64 hex characters in either case; not the reported event's id
    pub id: String,
    /// `hide` marks the report's targets hidden; `allow` clears them
    pub action: ReportAction,
}

/// The two decisions a report can be given.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportAction {
    /// `hide`: the report's targets are hidden (`actionable: true`).
    Hide,
    /// `allow`: the report's targets are not hidden (`actionable: false`).
    Allow,
}

impl JsonSchema for ReportAction {
    fn schema_name() -> Cow<'static, str> {
        "ReportAction".into()
    }

    /// The closed set as the schema's `enum`, which is what a validating client reads and what
    /// the field's own description calls it. The derive would state a described unit enum as a
    /// `oneOf` of `const` variants instead, because each variant's doc comment has nowhere to go
    /// in a plain `enum` list; the set is the same either way.
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "enum": ["hide", "allow"] })
    }

    fn inline_schema() -> bool {
        true
    }
}

/// The `settings_set` arguments: the same JSON object the console's HTTP body carries (R12).
///
/// Kept as a raw map rather than a typed struct because the schema's rule is that an explicit
/// `null` is a value and not an absent key: a typed `Option<Value>` would collapse the two and
/// turn the validator's `Expected string, got null` into `Invalid request`.
///
/// The `JsonSchema` below is the **advertisement** a validating client checks a body against;
/// `settings_patch` is the **enforcement**, in the handler, and the two state the same rule
/// twice on purpose — the schema cannot refuse a call, and the parser is not a schema.
#[derive(Debug, Clone, Deserialize)]
pub struct SettingsSetArgs {
    /// `{path, value}` or `{changes: [{path, value}, …]}`.
    #[serde(flatten)]
    pub body: Map<String, Value>,
}

impl JsonSchema for SettingsSetArgs {
    fn schema_name() -> Cow<'static, str> {
        "SettingsSetArgs".into()
    }

    /// The two shapes the write path takes and no others.
    ///
    /// A permissive `{"type": "object", "additionalProperties": true}` said every object was
    /// valid while the handler refused six of the seven shapes a client could send, and the
    /// refusal names no key. Modelled here instead: `{path, value}` or `{changes: [{path,
    /// value}, …]}` with at least one entry, and `additionalProperties: false` on both, so a
    /// validating client catches its own mistake and the schema and the handler agree.
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        let change = || {
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "minLength": 1 },
                    "value": {},
                },
                "required": ["path", "value"],
                "additionalProperties": false,
            })
        };
        json_schema!({
            "type": "object",
            "oneOf": [
                {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "minLength": 1 },
                        "value": {},
                    },
                    "required": ["path", "value"],
                    "additionalProperties": false,
                },
                {
                    "type": "object",
                    "properties": {
                        "changes": {
                            "type": "array",
                            "minItems": 1,
                            "items": change(),
                        },
                    },
                    "required": ["changes"],
                    "additionalProperties": false,
                },
            ],
        })
    }
}

/// The server: the shared admin state, the credential and the composition's identity.
#[derive(Debug, Clone)]
pub struct AdminMcp {
    state: Arc<AdminState>,
    /// The door's own credential, built by the composition root from its two flags (R27). Never
    /// the environment and never the console's session token: a gate that read either could not
    /// be revoked per door, and could not be tested without racing.
    credential: Credential,
    implementation: Implementation,
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl AdminMcp {
    /// Builds the server. `implementation` is the composition root's, so `serverInfo` carries
    /// the daemon's version and not this crate's (R6).
    pub fn new(
        state: Arc<AdminState>,
        credential: Credential,
        implementation: Implementation,
    ) -> Self {
        Self {
            state,
            credential,
            implementation,
            tool_router: Self::tool_router(),
        }
    }

    /// The relay's status (R9, R10): the composition's version, the facts the daemon publishes
    /// and the NIP-11 document this relay advertises.
    ///
    /// The published document is read per call. When it is absent, unreadable or past its
    /// freshness bound, every fact only the relay process can know is `null` with a reason —
    /// never `0`, which would read as "nothing is connected".
    #[tool(
        description = "Read the relay's status: the software version, the relay process's uptime, its live connection count and its worker rows, and the NIP-11 document it advertises. Facts only the relay process can know come from the status document it publishes; when that document is absent, unreadable or older than its freshness bound they are null, and `relay.reason` says which"
    )]
    async fn relay_status(&self) -> CallToolResult {
        match self.status_payload() {
            Ok(payload) => tool_ok(payload),
            Err(error) => tool_error(&error),
        }
    }

    /// `GET <prefix>/admin/settings`: the merged document narrowed to the defaults' keys and
    /// redacted, by the same two functions in the same order the controller uses (R11).
    #[tool(
        description = "Read the merged settings document, narrowed to the defaults' keys and redacted. The document arrives under `settings`"
    )]
    async fn settings_get(&self) -> CallToolResult {
        match self.settings_document() {
            Ok(document) => tool_ok(json!({ "settings": document })),
            Err(error) => tool_error(&error),
        }
    }

    /// `PATCH <prefix>/admin/settings`, through the controller's own write function (R13).
    #[tool(
        description = "Write settings: one path as {\"path\": \"wot.enabled\", \"value\": false}, or several as {\"changes\": [{\"path\": …, \"value\": …}, …]}. No other keys are accepted"
    )]
    async fn settings_set(
        &self,
        Parameters(arguments): Parameters<SettingsSetArgs>,
    ) -> CallToolResult {
        match patch_settings::apply(&self.state, &arguments.body, "").await {
            Ok(SettingsWrite::Written(body)) => tool_ok(body),
            Ok(SettingsWrite::Refused { body, .. }) => tool_error_body(&body),
            Err(error) => tool_error(&McpError::from(error)),
        }
    }

    /// One `EventRepository` read over one [`Filter`], through `collect_records` so a vanished
    /// slot never reaches the payload (R15), and through `collect_page` where the page's size
    /// decides something, so a spent slot is not read as a short page.
    #[tool(
        description = "List stored events matching the given kinds, authors, ids, since and until. Rows come back oldest first, and `limit` is the page size — the first rows in that order, at most 500; `truncated` is true when the page is full, so more rows may match"
    )]
    async fn list_events(
        &self,
        Parameters(criteria): Parameters<ListEventsArgs>,
    ) -> CallToolResult {
        match self.events(criteria).await {
            Ok((records, truncated)) => {
                tool_ok(json!({ "events": records, "truncated": truncated }))
            }
            Err(error) => tool_error(&error),
        }
    }

    /// One exact-id read: the filter selects prefixes, so the row's id is compared for equality
    /// before it is returned (R16).
    #[tool(
        description = "Read one stored event by its exact 64-character hex id, in either case; null when no such id is stored"
    )]
    async fn get_event(&self, Parameters(arguments): Parameters<GetEventArgs>) -> CallToolResult {
        match self.event(&arguments.id).await {
            Ok(Some(record)) => tool_ok(json!({ "event": record })),
            Ok(None) => tool_ok(json!({ "event": null })),
            Err(error) => tool_error(&error),
        }
    }

    /// The store's own soft delete, on one row: the exact-id read names the pubkey the seam
    /// needs, one call flips the row, and the read-back carries the `deleted_at` the store
    /// stamped (R1, R3).
    #[tool(
        description = "Mark one stored event deleted: the same soft delete a NIP-09 request from the \
author makes. The event leaves REQ and COUNT and keeps its row, so `get_event` and `list_events` \
still return it with `deleted_at` set — unless an actionable report hides it, in which case it \
stays hidden until the report is allowed. The argument is the event's hex id; a prefix shorter \
than 64 characters is refused rather than widened to whatever the store's range would match. Answers `outcome` — `deleted`, \
`already_deleted`, `not_deleteable` (kind 62 is never deleted), or `not_found` — and the row as \
it stands after the call"
    )]
    async fn delete_event(
        &self,
        Parameters(arguments): Parameters<DeleteEventArgs>,
    ) -> CallToolResult {
        match self.deleted(&arguments.id).await {
            Ok(payload) => tool_ok(payload),
            Err(error) => tool_error(&error),
        }
    }

    /// One report event's triage decision: its own id, resolved through the report store, and
    /// every row it wrote flipped to `actionable` or off it (R7, R13).
    #[tool(
        description = "Act on one report event: `hide` marks its targets hidden (`actionable: true`, \
so REQ and COUNT withhold them while `nip56.hideActionableReports` is on) and `allow` clears them \
(`actionable: false`). The argument is the report's own kind-1984 event id — exactly 64 hex \
characters, not the reported event's id — and every report row that event wrote is flipped. \
Answers `reports` (the rows as they stand, by `id`) and `changed` (how many this call flipped). \
Every new REQ reflects the change at once; already-connected subscriptions see it at the relay's \
next refresh, up to 30 s"
    )]
    async fn reports_action(
        &self,
        Parameters(arguments): Parameters<ReportsActionArgs>,
    ) -> CallToolResult {
        match self.act_on_report(&arguments).await {
            Ok(payload) => tool_ok(payload),
            Err(error) => tool_error(&error),
        }
    }

    /// The delete payload: one outcome from the store's own count and the row **as it stands
    /// after** the call, and that row (R3, R4).
    ///
    /// The read is [`EventRepository::find_stored`], not `get_event`'s gated read: a delete must
    /// reach the events a moderator has just hidden, or this slice's two tools contradict each
    /// other. The outcome comes from the post-call row rather than the pre-read, because a
    /// pre-read is stale the moment a second caller deletes the row first — that row answers
    /// `already_deleted`, and only a live one answers `not_deleteable`.
    async fn deleted(&self, id: &str) -> Result<Value, McpError> {
        let id = hex_prefix("id", id)?;
        if id.len() != 64 {
            return Err(McpError::Criterion(format!(
                "id: {id:?} is not a 64-character hex id"
            )));
        }
        let event_id = EventId::try_from(id.as_str())
            .map_err(|error| McpError::Criterion(error.to_string()))?;
        let events = &self.state.stores().events;
        let Some(row) = events.find_stored(&event_id).await? else {
            return Ok(json!({ "outcome": OUTCOME_NOT_FOUND, "event": null }));
        };
        let count = events
            .delete_by_pubkey_and_ids(&row.event.pubkey, &[row.event.id])
            .await?;
        let after = events.find_stored(&event_id).await?;
        let outcome = if count > 0 {
            OUTCOME_DELETED
        } else if after.as_ref().is_some_and(|row| row.deleted_at.is_some()) {
            OUTCOME_ALREADY_DELETED
        } else {
            OUTCOME_NOT_DELETEABLE
        };
        Ok(json!({ "outcome": outcome, "event": after }))
    }

    /// The report payload: the rows one report event wrote, sorted by `id` because neither
    /// backend orders that read, and how many this call flipped (R13).
    ///
    /// An id with no rows is a result rather than an error — the answer `get_event` gives an
    /// unknown id — so a caller that mistyped one sees an empty list and not `Not Found`.
    async fn act_on_report(&self, arguments: &ReportsActionArgs) -> Result<Value, McpError> {
        let id = hex_prefix("id", &arguments.id)?;
        if id.len() != 64 {
            return Err(McpError::Criterion(format!(
                "id: {id:?} is not a 64-character hex id"
            )));
        }
        let event_id = EventId::try_from(id.as_str())
            .map_err(|error| McpError::Criterion(error.to_string()))?;
        let reports = &self.state.stores().reports;
        if reports.find_by_event_id(&event_id).await?.is_empty() {
            return Ok(json!({ "reports": [], "changed": 0 }));
        }
        let changed = reports
            .set_actionable(&event_id, !matches!(arguments.action, ReportAction::Allow))
            .await?;
        let mut rows = reports.find_by_event_id(&event_id).await?;
        rows.sort_by_key(|report| report.id);
        Ok(json!({ "reports": rows, "changed": changed }))
    }

    fn settings_document(&self) -> Result<Value, McpError> {
        let (merged, defaults) = self.state.merged_document()?;
        let filtered = nostream_config::store::filter_against_defaults(&merged, &defaults);
        let redacted = nostream_config::redaction::redact_settings_secrets(&filtered);
        Ok(serde_json::to_value(redacted)?)
    }

    /// The `relay_status` payload: `version`, the published `relay` block and `nip11` (R10).
    ///
    /// The document is read per call, so nothing is cached at start. A failed read is not an
    /// error: it is the payload's `reason`, with every fact the relay process alone can know
    /// `null`. `nip11.self` is one of them: it is the key the published document names, never
    /// one this process derived from its own environment.
    fn status_payload(&self) -> Result<Value, McpError> {
        let settings = self.state.settings()?;
        let published = status::read(self.state.paths(), self.state.clock().now_ms());
        let signing_pubkey = published
            .as_ref()
            .ok()
            .and_then(|published| published.document.relay_pubkey);
        let nip11 = serde_json::to_value(nip11::document(
            &settings,
            &self.implementation.version,
            signing_pubkey,
        ))?;
        let relay = match published {
            Ok(published) => json!({
                "reason": null,
                "observedAt": published.document.generated_at,
                "ageSeconds": published.age_seconds,
                "uptimeSeconds": published.document.uptime_seconds,
                "activeConnections": published.document.active_connections,
                "workers": published.document.workers,
            }),
            Err(error) => json!({
                "reason": error.reason,
                "observedAt": null,
                "ageSeconds": null,
                "uptimeSeconds": null,
                "activeConnections": null,
                "workers": null,
            }),
        };

        Ok(json!({
            "version": &self.implementation.version,
            "relay": relay,
            "nip11": nip11,
        }))
    }

    /// One page, oldest first, and whether it was full.
    ///
    /// No `limit` goes to the store, because the store picks its direction from it: a filter
    /// carrying one is answered newest-first, which would make the payload's order depend on an
    /// unrelated argument. Ascending is the store's unlimited page, whose bound is
    /// [`MAX_ROWS_PER_PAGE`], so `limit` is applied to that page here and the marker counts
    /// **slots**, not rows: a page that selected a key a concurrent replacement or a retention
    /// pass then removed spends that slot and yields no row, and counting the surviving rows
    /// would answer `truncated: false` to a caller with more rows still to read.
    async fn events(&self, criteria: ListEventsArgs) -> Result<(Vec<EventRecord>, bool), McpError> {
        let page = page_size(&criteria)?;
        let filter = Filter {
            kinds: criteria
                .kinds
                .map(|kinds| kinds.into_iter().map(Kind).collect()),
            authors: prefixed("authors", criteria.authors)?,
            ids: prefixed("ids", criteria.ids)?,
            since: criteria.since,
            until: criteria.until,
            limit: None,
            ..Filter::default()
        };
        let filters = [filter];
        let stream = self.state.stores().events.find_by_filters(&filters).await?;
        let (mut records, slots) = collect_page(stream).await?;
        let truncated = slots >= page;
        records.truncate(page);
        Ok((records, truncated))
    }

    async fn event(&self, id: &str) -> Result<Option<EventRecord>, McpError> {
        let id = hex_prefix("id", id)?;
        let filters = [Filter {
            ids: Some(vec![id.clone()]),
            limit: Some(1),
            ..Filter::default()
        }];
        let stream = self.state.stores().events.find_by_filters(&filters).await?;
        let records = collect_records(stream).await?;
        // `Filter::ids` members are hex prefixes and the store widens a short one to a
        // whole-field range, so only an equal id is the event that was asked for (R16).
        Ok(records
            .into_iter()
            .find(|record| record.event.id.to_string() == id))
    }

    /// The grant the call runs under, or the refusal that stops it (R27–R29): the console's
    /// enabled predicate first, then the document — which the file form reads right here, so a
    /// rewrite or a deletion is in force by the time this answers.
    ///
    /// The document's own failure is the operator's to read, not the caller's: `Unauthorized` is
    /// what a pipe sees, and the reason goes to the log where the file's path is meaningful.
    fn grant(&self) -> Result<Scopes, &'static str> {
        if !self.surface_enabled() {
            return Err(NOT_FOUND);
        }
        self.credential.grant().map_err(|error| {
            tracing::warn!(%error, "the MCP credential was refused");
            UNAUTHORIZED
        })
    }

    /// R28's line: an authenticated call the document's scopes deny. It carries the tool and the
    /// scope it needed, never an argument value, and it is written before the refusal is
    /// returned, so a denied write is visible in `admin-audit.jsonl` rather than absent from it.
    ///
    /// The name is one of [`TOOLS`]' constants rather than the caller's text: `call_tool` refuses
    /// a name the table does not carry before it reaches this, so the size of the line is the
    /// table's, not the caller's.
    fn record_denial(&self, tool: &'static str, scope: &str) {
        let detail = json!({ "tool": tool, "scope": scope });
        if let Err(error) = self.state.append_audit(AUDIT_DENIED, None, Some(detail)) {
            tracing::warn!(%error, tool, "the MCP denial was not recorded");
        }
    }

    /// `admin.enabled`, the predicate `admin_enabled_middleware` gates the console with.
    fn surface_enabled(&self) -> bool {
        self.state
            .settings()
            .ok()
            .and_then(|settings| settings.admin.map(|admin| admin.enabled))
            .unwrap_or(false)
    }

    /// R9's line, appended at dispatch: the tool name and the requested paths are the
    /// arguments, so nothing recorded depends on what the handler then does.
    fn record_dispatch(&self, tool: &str, arguments: Option<&Map<String, Value>>) {
        let detail = dispatch_detail(tool, arguments);
        if let Err(error) = self
            .state
            .append_audit(&audit_action(tool), None, Some(detail))
        {
            tracing::warn!(%error, tool, "the MCP audit entry was not recorded");
        }
    }
}

/// The page a call asks for, checked against the bounds its `inputSchema` states.
fn page_size(criteria: &ListEventsArgs) -> Result<usize, McpError> {
    let limit = criteria.limit.unwrap_or(MAX_ROWS_PER_PAGE);
    let page = usize::try_from(limit).ok().filter(|page| {
        (1..=usize::try_from(MAX_ROWS_PER_PAGE).unwrap_or(usize::MAX)).contains(page)
    });
    page.ok_or_else(|| {
        McpError::Criterion(format!(
            "limit: a page holds between 1 and {MAX_ROWS_PER_PAGE} rows, {limit} was given"
        ))
    })
}

/// One criterion list, normalised to lowercase hex: the wire's own floor, and at most
/// [`MAX_FILTER_TERMS`] of them.
fn prefixed(field: &str, values: Option<Vec<String>>) -> Result<Option<Vec<String>>, McpError> {
    let Some(values) = values else {
        return Ok(None);
    };
    if values.len() > MAX_FILTER_TERMS {
        return Err(McpError::Criterion(format!(
            "{field}: at most {MAX_FILTER_TERMS} criteria per call, {} were given",
            values.len()
        )));
    }
    values
        .iter()
        .map(|value| hex_prefix(field, value))
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// A criterion the store can answer in time.
///
/// The wire refuses what this path used to admit: `nostream_core::filter::validate_prefixes`
/// (`crates/nostream-core/src/filter.rs:386-401`) requires 4 to 64 lowercase hex characters on
/// every `ids`/`authors` criterion, and without it the store maps each byte outside `0-9a-fA-F`
/// to `0` (`crates/nostream-storage/src/lmdb/encoding.rs:426-432`) and widens a short criterion
/// to a whole-field range, so `{"id": ""}` visits the entire `events` database. Either case is
/// accepted and normalised, because the stored ids are lowercase: a caller that pasted an
/// uppercase id gets its row, not a confident "not found".
fn hex_prefix(field: &str, value: &str) -> Result<String, McpError> {
    let length = value.len();
    if !(4..=64).contains(&length) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(McpError::Criterion(format!(
            "{field}: {value:?} is not a 4-to-64-character hex prefix"
        )));
    }
    Ok(value.to_ascii_lowercase())
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for AdminMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(self.implementation.clone())
            .with_instructions(MCP_INSTRUCTIONS)
    }

    /// The gate and the audit sink, in front of the router's dispatch.
    ///
    /// `tools/list` is not gated (R8): a client discovers the surface before it presents a
    /// credential, and the refusal is at the call. The order is the console's — the enabled
    /// predicate, then the credential — after which the name is asked of the table **and** the
    /// router: is it one this door serves, then what scope it needs, then whether its arguments
    /// parse (R9, R28). A scope is only meaningful once the document that names it has been read,
    /// and a name either of them does not carry is a refusal rather than a tool.
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        let scopes = match self.grant() {
            Ok(scopes) => scopes,
            Err(refusal) => {
                // The caller's text reaches one record on this arm, and it is written before any
                // credential is checked: the line carries a cut, escaped prefix, so the name can
                // neither size it nor end it and start one of its own.
                let name = logged_name(&request.name);
                tracing::warn!(tool = %name, refusal, "the MCP call was refused");
                return Ok(tool_refusal(refusal).into());
            }
        };
        // The table and the router answer together, and an absence from either is a refusal, not
        // a dispatch: a name neither serves is answered exactly as the router answers it —
        // `-32602 tool not found` — before the scopes are consulted and before any line is
        // written. A tool added to the router without its row is therefore unreachable rather
        // than unaudited, and a row whose method is absent writes no line for a call that reached
        // nothing (R9, D18); the name a line records is one of these constants.
        let Some(entry) = served(&self.tool_router, &request.name) else {
            return Err(rmcp::ErrorData::invalid_params(TOOL_NOT_FOUND, None));
        };
        if let Requires::Write = entry.needs
            && !scopes.includes(SCOPE_WRITE)
        {
            self.record_denial(entry.name, SCOPE_WRITE);
            return Ok(tool_refusal(&format!(
                "{FORBIDDEN}: {} needs the \"{SCOPE_WRITE}\" scope",
                entry.name
            ))
            .into());
        }
        // `false` — the router answers a deserialisation failure with its own error result —
        // reaches no tool, so it writes no line (R9, Assumption 5); `true` writes the line before
        // the handler runs, which is what the check is for.
        if (entry.parses)(request.arguments.as_ref()) {
            self.record_dispatch(entry.name, request.arguments.as_ref());
        }
        let call = ToolCallContext::new(self, request, context);
        self.tool_router.call(call).await
    }
}

/// The detail an `mcp.<tool>` line carries: the tool, plus the requested paths for
/// `settings_set` — never a value (R9).
fn dispatch_detail(tool: &str, arguments: Option<&Map<String, Value>>) -> Value {
    if tool == TOOL_SETTINGS_SET
        && let Some(patch) = arguments.and_then(settings_patch)
    {
        let paths: Vec<&str> = patch
            .changes
            .iter()
            .map(|change| change.path.as_str())
            .collect();
        return json!({ "tool": tool, "paths": paths });
    }
    json!({ "tool": tool })
}

/// A failure as an `isError: true` result, carrying the error's own message so the caller can
/// read it: a JSON-RPC error would reach them as an opaque internal failure.
fn tool_error(error: &McpError) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(error.to_string())])
}

/// A gate refusal as an `isError: true` result: the credential is the caller's to fix, and a
/// JSON-RPC error would read as the server's fault (R28).
fn tool_refusal(text: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(text)])
}

/// The most of a caller's tool name a log line carries: the log is a diagnostic, and the name is
/// the caller's text on an arm reached before any credential.
const LOGGED_NAME_CHARS: usize = 64;

/// Caller text as a log line may carry it: at most [`LOGGED_NAME_CHARS`] characters, with anything
/// that is not printable escaped, so a name can neither set the line's length nor end it and start
/// one of its own. The audit file's caller-text sink is closed the same way — `record_denial`
/// takes a [`TOOLS`] constant — and this is the remaining place a caller chooses a record's shape.
fn logged_name(name: &str) -> String {
    name.chars()
        .take(LOGGED_NAME_CHARS)
        .flat_map(|character| character.escape_debug())
        .collect()
}

/// A refusal body as an `isError: true` result — the controller's own JSON, rendered (R13).
fn tool_error_body(body: &Value) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(body.to_string())])
}

/// A success: the payload in `structuredContent`, and no copy of it in `content`.
///
/// `CallToolResult::structured` fills `content` with `value.to_string()` *and* sets
/// `structured_content`, so every page crossed the wire twice — 48.3% of a 5,000-row response
/// was a text copy nothing read. A client reads `structuredContent`; the protocol allows an
/// empty `content` array, which is what this sends.
fn tool_ok(payload: Value) -> CallToolResult {
    let mut result = CallToolResult::default();
    result.structured_content = Some(payload);
    result.is_error = Some(false);
    result
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    /// The door serves a name the table carries **and** the router dispatches. `TOOLS` is a
    /// `const`, so a row with no `#[tool]` method cannot be added by a case; removing the route
    /// from the router's `map` is the same disagreement from the other side, and it is the state
    /// D18 forbids a line for: the table's `row` still answers, the dispatch does not.
    #[test]
    fn a_row_without_a_route_is_not_served() {
        let mut router = AdminMcp::tool_router();
        assert!(
            served(&router, TOOL_SETTINGS_GET).is_some(),
            "the row and the route agree to begin with"
        );
        router.map.remove(TOOL_SETTINGS_GET);
        assert!(
            row(TOOL_SETTINGS_GET).is_some(),
            "the table still carries the name"
        );
        assert!(
            served(&router, TOOL_SETTINGS_GET).is_none(),
            "the router's map decides dispatch, so it decides the refusal"
        );
    }

    /// The log line takes a prefix of the caller's name and no control character from it: the
    /// name is unbounded and newline-capable, the line is neither.
    #[test]
    fn a_logged_name_is_cut_and_escaped() {
        assert_eq!(logged_name(&"n".repeat(200_000)).len(), LOGGED_NAME_CHARS);
        assert_eq!(
            logged_name("probe\nWARN forged line"),
            r"probe\nWARN forged line"
        );
        assert_eq!(logged_name(TOOL_SETTINGS_GET), TOOL_SETTINGS_GET);
    }
}
