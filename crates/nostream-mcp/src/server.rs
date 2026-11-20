//! The MCP server: the four tools, the credential gate and the audit sink.
//!
//! Every tool is a thin handler over a seam that already exists — `AdminState` for the settings,
//! `EventRepository` for the events — and nothing here knows what an HTTP status is (R3). The
//! gate and the audit line live in [`ServerHandler::call_tool`], at dispatch: a call the gate
//! refuses reaches no tool and writes nothing (R8), and a call that reaches a tool has its
//! `mcp.<tool>` line written before the tool's own work, so the file's order is the dispatch
//! order (R9).

use std::borrow::Cow;
use std::sync::Arc;

use nostream_admin::AdminState;
use nostream_admin::controllers::admin_json_body_middleware::settings_patch;
use nostream_admin::controllers::patch_settings::{self, SettingsWrite};
use nostream_admin::utils::session;
use nostream_core::{Filter, Kind};
use nostream_storage::repositories::{EventRecord, collect_records};
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

use crate::error::McpError;

/// The server name `initialize` reports: the server, not the SDK, which would name `rmcp` (R6).
pub const MCP_SERVER_NAME: &str = "nostream";

/// What `initialize`'s `instructions` carries: the route to a working call.
///
/// The three refusals the gate answers name a symptom, not its cause, and nothing else on the
/// surface says what a caller needs — a client that reads `Not Found` for a tool it was just
/// told exists has nowhere to look. This is that place, and it is additive: the refusal texts
/// stay exactly as the console's layers word them.
pub const MCP_INSTRUCTIONS: &str = "\
The nostream admin MCP server. It uses the admin console's own credential: a session token \
minted by `POST /admin/login` and passed in `NOSTREAM_ADMIN_TOKEN`. Three things must hold, or \
every call is refused with the reason: `admin.enabled` is true in the settings (else `Not \
Found`), `SECRET` is set (else `Internal Server Error`), and `NOSTREAM_ADMIN_TOKEN` carries an \
unexpired token (else `Unauthorized`). Each executed call appends one `mcp.<tool>` line to \
`<config>/admin-audit.jsonl`.";

/// The tool names slice 1 registers (R5). Each is also its audit action's suffix (R9).
pub const TOOL_SETTINGS_GET: &str = "settings_get";
pub const TOOL_SETTINGS_SET: &str = "settings_set";
pub const TOOL_LIST_EVENTS: &str = "list_events";
pub const TOOL_GET_EVENT: &str = "get_event";

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

/// The refusal for a token that is absent, malformed or expired — the HTTP gate's `401`.
pub const UNAUTHORIZED: &str = "Unauthorized";

/// The refusal for a surface whose `SECRET` is absent — the HTTP gate's `500`.
pub const INTERNAL_SERVER_ERROR: &str = "Internal Server Error";

/// The refusal for a surface `admin.enabled` does not turn on — the console's `404`.
pub const NOT_FOUND: &str = "Not Found";

/// The audit action one dispatched call records: `mcp.<tool>` (R9).
pub fn audit_action(tool: &str) -> String {
    format!("mcp.{tool}")
}

/// Whether the router can deserialise a call's arguments: the same type its handler takes.
type ArgumentsCheck = fn(Option<&Map<String, Value>>) -> bool;

/// The audit table: every tool the router registers, with the check that says whether the
/// router can deserialise a call's arguments (R9).
///
/// The rule each entry keeps is **no stricter than the router's own deserialisation**, not "the
/// shape the `inputSchema` states". [`ServerHandler::call_tool`] writes the line when the check
/// answers `true` and then dispatches unconditionally, so a check that refused a call the router
/// runs would execute it unaudited — R9's guarantee failing open. The check exists to write the
/// line *before* the handler, never to refuse a call; `settings_set`'s is therefore deliberately
/// vacuous, because its arguments are a raw map and its `inputSchema` is the half that refuses.
///
/// The dispatch path looks a name up here and has no "everything else is audited" arm, so a
/// tool added to the router without an entry cannot execute unaudited: it fails
/// `every_registered_tool_is_in_the_audit_table`, which reads the router's own list.
pub const TOOL_ARGUMENTS: &[(&str, ArgumentsCheck)] = &[
    (TOOL_SETTINGS_GET, accepts_any_arguments),
    (TOOL_SETTINGS_SET, settings_set_parses),
    (TOOL_LIST_EVENTS, list_events_parse),
    (TOOL_GET_EVENT, get_event_parses),
];

/// Whether `tool`'s arguments parse; `None` when the router registers no such tool.
pub fn arguments_parse(tool: &str, arguments: Option<&Map<String, Value>>) -> Option<bool> {
    TOOL_ARGUMENTS
        .iter()
        .find(|(name, _)| *name == tool)
        .map(|(_, parses)| parses(arguments))
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

/// The server: the shared admin state, the resolved token and the composition's identity.
#[derive(Debug, Clone)]
pub struct AdminMcp {
    state: Arc<AdminState>,
    /// `NOSTREAM_ADMIN_TOKEN` as a value, read once by the composition root (R7). Never the
    /// environment: a gate that read it per call could not be tested without racing.
    token: Option<String>,
    implementation: Implementation,
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl AdminMcp {
    /// Builds the server. `implementation` is the composition root's, so `serverInfo` carries
    /// the daemon's version and not this crate's (R6).
    pub fn new(
        state: Arc<AdminState>,
        token: Option<String>,
        implementation: Implementation,
    ) -> Self {
        Self {
            state,
            token,
            implementation,
            tool_router: Self::tool_router(),
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
    /// slot never reaches the payload (R15).
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

    fn settings_document(&self) -> Result<Value, McpError> {
        let (merged, defaults) = self.state.merged_document()?;
        let filtered = nostream_config::store::filter_against_defaults(&merged, &defaults);
        let redacted = nostream_config::redaction::redact_settings_secrets(&filtered);
        Ok(serde_json::to_value(redacted)?)
    }

    /// One page, oldest first, and whether it was full.
    ///
    /// No `limit` goes to the store, because the store picks its direction from it: a filter
    /// carrying one is answered newest-first, which would make the payload's order depend on an
    /// unrelated argument. Ascending is the store's unlimited page, whose bound is
    /// [`MAX_ROWS_PER_PAGE`], so `limit` is applied to that page here and the marker is
    /// `len >= limit`.
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
        let mut records = collect_records(stream).await?;
        let truncated = records.len() >= page;
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

    /// The gate's refusal, if the call cannot run (R7): the console's enabled predicate first,
    /// then its `SECRET`, then its session token — the three checks its own layers make, in the
    /// order its router makes them.
    fn refusal(&self) -> Option<&'static str> {
        if !self.surface_enabled() {
            return Some(NOT_FOUND);
        }
        let Some(secret) = self.state.secret() else {
            return Some(INTERNAL_SERVER_ERROR);
        };
        let key = session::session_key(secret);
        match &self.token {
            Some(token) if session::is_valid_token(&key, token, self.state.clock().now_secs()) => {
                None
            }
            _ => Some(UNAUTHORIZED),
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
    /// credential, and the refusal is at the call.
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        if let Some(refusal) = self.refusal() {
            tracing::warn!(tool = %request.name, refusal, "the MCP call was refused");
            return Ok(CallToolResult::error(vec![ContentBlock::text(refusal)]).into());
        }
        // `Some(false)` — the router answers the deserialisation failure — and `None` — no such
        // tool, and the router answers `-32602` — both reach no tool, so neither writes a line
        // (R9, Assumption 5).
        if let Some(true) = arguments_parse(&request.name, request.arguments.as_ref()) {
            self.record_dispatch(&request.name, request.arguments.as_ref());
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
