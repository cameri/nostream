//! The MCP server: the four tools, the credential gate and the audit sink.
//!
//! Every tool is a thin handler over a seam that already exists — `AdminState` for the settings,
//! `EventRepository` for the events — and nothing here knows what an HTTP status is (R3). The
//! gate and the audit line live in [`ServerHandler::call_tool`], at dispatch: a call the gate
//! refuses reaches no tool and writes nothing (R8), and a call that reaches a tool has its
//! `mcp.<tool>` line written before the tool's own work, so the file's order is the dispatch
//! order (R9).

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
use rmcp::schemars::{self, JsonSchema};
use rmcp::service::RequestContext;
use rmcp::{RoleServer, ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::error::McpError;

/// The server name `initialize` reports: the server, not the SDK, which would name `rmcp` (R6).
pub const MCP_SERVER_NAME: &str = "nostream";

/// The tool names slice 1 registers (R5). Each is also its audit action's suffix (R9).
pub const TOOL_SETTINGS_GET: &str = "settings_get";
pub const TOOL_SETTINGS_SET: &str = "settings_set";
pub const TOOL_LIST_EVENTS: &str = "list_events";
pub const TOOL_GET_EVENT: &str = "get_event";

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

/// The `list_events` criteria: each maps to one [`Filter`] field (R15).
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct ListEventsArgs {
    /// Kinds to select; absent selects every kind.
    pub kinds: Option<Vec<u64>>,
    /// Author pubkey hex prefixes.
    pub authors: Option<Vec<String>>,
    /// Event id hex prefixes.
    pub ids: Option<Vec<String>>,
    /// Events created at or after this unix second.
    pub since: Option<i64>,
    /// Events created at or before this unix second.
    pub until: Option<i64>,
    /// Page size; absent leaves the store's own default in charge.
    pub limit: Option<u64>,
}

/// The `get_event` arguments.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct GetEventArgs {
    /// The event's 64-character lowercase hex id.
    pub id: String,
}

/// The `settings_set` arguments: the same JSON object the console's HTTP body carries (R12).
///
/// Kept as a raw map rather than a typed struct because the schema's rule is that an explicit
/// `null` is a value and not an absent key: a typed `Option<Value>` would collapse the two and
/// turn the validator's `Expected string, got null` into `Invalid request`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SettingsSetArgs {
    /// `{path, value}` or `{changes: [{path, value}, …]}`.
    #[serde(flatten)]
    pub body: Map<String, Value>,
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
        description = "Read the merged settings document, narrowed to the defaults' keys and redacted"
    )]
    async fn settings_get(&self) -> CallToolResult {
        match self.settings_document() {
            Ok(document) => CallToolResult::structured(json!({ "settings": document })),
            Err(error) => tool_error(&error),
        }
    }

    /// `PATCH <prefix>/admin/settings`, through the controller's own write function (R13).
    #[tool(
        description = "Write settings: one path as {\"path\": \"wot.enabled\", \"value\": false}, or several as {\"changes\": [{\"path\": …, \"value\": …}, …]}"
    )]
    async fn settings_set(
        &self,
        Parameters(arguments): Parameters<SettingsSetArgs>,
    ) -> CallToolResult {
        match patch_settings::apply(&self.state, &arguments.body, "").await {
            Ok(SettingsWrite::Written(body)) => CallToolResult::structured(body),
            Ok(SettingsWrite::Refused { body, .. }) => tool_error_body(&body),
            Err(error) => tool_error(&McpError::from(error)),
        }
    }

    /// One `EventRepository` read over one [`Filter`], through `collect_records` so a vanished
    /// slot never reaches the payload (R15).
    #[tool(
        description = "List stored events matching the given kinds, authors, ids, since and until, up to limit"
    )]
    async fn list_events(
        &self,
        Parameters(criteria): Parameters<ListEventsArgs>,
    ) -> CallToolResult {
        match self.events(criteria).await {
            Ok(records) => CallToolResult::structured(json!({ "events": records })),
            Err(error) => tool_error(&error),
        }
    }

    /// One exact-id read: the filter selects prefixes, so the row's id is compared for equality
    /// before it is returned (R16).
    #[tool(
        description = "Read one stored event by its exact 64-character hex id; null when no such id is stored"
    )]
    async fn get_event(&self, Parameters(arguments): Parameters<GetEventArgs>) -> CallToolResult {
        match self.event(&arguments.id).await {
            Ok(Some(record)) => CallToolResult::structured(json!({ "event": record })),
            Ok(None) => CallToolResult::structured(json!({ "event": null })),
            Err(error) => tool_error(&error),
        }
    }

    fn settings_document(&self) -> Result<Value, McpError> {
        let (merged, defaults) = self.state.merged_document()?;
        let filtered = nostream_config::store::filter_against_defaults(&merged, &defaults);
        let redacted = nostream_config::redaction::redact_settings_secrets(&filtered);
        Ok(serde_json::to_value(redacted)?)
    }

    async fn events(&self, criteria: ListEventsArgs) -> Result<Vec<EventRecord>, McpError> {
        // No default limit: an absent `limit` leaves the store's `DEFAULT_FILTER_LIMIT` in
        // charge, which is what a caller who passed none is entitled to (R15).
        let filter = Filter {
            kinds: criteria
                .kinds
                .map(|kinds| kinds.into_iter().map(Kind).collect()),
            authors: criteria.authors,
            ids: criteria.ids,
            since: criteria.since,
            until: criteria.until,
            limit: criteria.limit,
            ..Filter::default()
        };
        let filters = [filter];
        let stream = self.state.stores().events.find_by_filters(&filters).await?;
        Ok(collect_records(stream).await?)
    }

    async fn event(&self, id: &str) -> Result<Option<EventRecord>, McpError> {
        let filters = [Filter {
            ids: Some(vec![id.to_owned()]),
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

/// Whether a call's arguments are the shape its `inputSchema` states.
///
/// The router answers a deserialisation failure with its own `isError` result, and R9 puts that
/// failure on the same footing as a refused credential: nothing is written. So the audit line is
/// emitted only for a call that will reach a tool, which needs the arguments checked before
/// dispatch — against the same types the tools take, so the two cannot drift.
fn arguments_parse(tool: &str, arguments: Option<&Map<String, Value>>) -> bool {
    let arguments = Value::Object(arguments.cloned().unwrap_or_default());
    match tool {
        // No parameters: the router deserialises nothing, so anything is accepted.
        TOOL_SETTINGS_GET => true,
        TOOL_SETTINGS_SET => serde_json::from_value::<SettingsSetArgs>(arguments).is_ok(),
        TOOL_LIST_EVENTS => serde_json::from_value::<ListEventsArgs>(arguments).is_ok(),
        TOOL_GET_EVENT => serde_json::from_value::<GetEventArgs>(arguments).is_ok(),
        // An unknown tool is not dispatched at all: the router answers `-32602` and nothing runs.
        _ => false,
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for AdminMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(self.implementation.clone())
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
        if arguments_parse(&request.name, request.arguments.as_ref()) {
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
