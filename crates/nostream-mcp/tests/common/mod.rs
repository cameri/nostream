//! The MCP test harness: `AdminState` over a temporary config dir and an LMDB store, and an
//! in-process duplex client — no child process and no port.
//!
//! The state is composed the way `crates/nostream-admin/tests/common/mod.rs:153-232` composes it,
//! minus the HTTP server: the same fixture values (`SECRET`, `PASSWORD_HASH`, `NOW_MS`), the same
//! seeding pattern (`crates/nostream-storage/tests/parity_lmdb.rs:84-92`) and the console's real
//! `resources/` tree as the schema source. The client is `rmcp`'s over `tokio::io::duplex`, which
//! is the only way to call a tool without a transport (`Peer::new` is `pub(crate)` in the SDK).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use nostream_admin::state::AdminStateConfig;
use nostream_admin::utils::session;
use nostream_admin::{AdminState, GrafanaSettings};
use nostream_config::SettingsPaths;
use nostream_core::clock::TestClock;
use nostream_core::nip05::Nip05Fetch;
use nostream_core::random::SystemRandom;
use nostream_core::{Event, EventId, Kind, Pubkey, Signature};
use nostream_mcp::{AdminMcp, MCP_SERVER_NAME};
use nostream_services::{HttpClient, ReqwestClient, ServiceStores};
use nostream_storage::lmdb::LmdbBackend;
use nostream_storage::repositories::{EventRecord, EventRepository};
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientCapabilities, ClientConfig, Implementation,
    ProtocolVersion, Tool,
};
use rmcp::service::RunningService;
use rmcp::{RoleClient, ServiceError, ServiceExt};
use serde_json::{Map, Value};
use tokio::task::JoinHandle;

/// The repository root, from the crate's manifest directory.
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The resources root the settings schema is read from.
pub fn resources_root() -> PathBuf {
    repo_root().join("resources")
}

/// The fixture password hash `hashAdminPassword` writes for `hunter2`.
pub const PASSWORD_HASH: &str = "scrypt:BwcHBwcHBwcHBwcHBwcHBw==:r5daXU05UJ9EUDu45YoHMWUoQCmkVbwINYNntY1/dwrJPOt3fTi/1IWw1wp9+YXRj1Vm6IpFi+gSU0JdqZvWIw==";

/// The literal `SECRET` the fixture signs sessions with.
pub const SECRET: &[u8] = b"a-test-secret";

/// The clock the fixture starts at.
pub const NOW_MS: u64 = 1_700_000_000_000;

/// The console's happy-path settings: the surface on and the fixture hash.
pub fn base_settings() -> serde_yaml::Value {
    serde_yaml::from_str(&format!(
        "info:\n  name: Example\n  relay_url: wss://relay.example\nadmin:\n  enabled: true\n  passwordHash: \"{PASSWORD_HASH}\"\n"
    ))
    .unwrap()
}

/// The token a case presents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Token {
    /// A valid session token minted from the fixture's `SECRET`.
    Valid,
    /// No token at all.
    Absent,
    /// A token that expired one second before the fixture's clock.
    Expired,
}

/// What a test wants built.
pub struct Fixture {
    /// The user settings document written to `<config>/settings.yaml`.
    pub settings: serde_yaml::Value,
    /// `SECRET` as a value; `None` is the missing-secret case.
    pub secret: Option<Vec<u8>>,
    /// The token the server is built with.
    pub token: Token,
    /// The starting clock reading.
    pub now_ms: u64,
}

impl Default for Fixture {
    fn default() -> Self {
        Self {
            settings: base_settings(),
            secret: Some(SECRET.to_vec()),
            token: Token::Valid,
            now_ms: NOW_MS,
        }
    }
}

impl Fixture {
    /// The base settings with one path replaced.
    pub fn with(mut self, path: &str, value: Value) -> Self {
        let value: serde_yaml::Value = serde_yaml::from_str(&value.to_string()).unwrap();
        self.settings = nostream_config::path::set_by_path(&self.settings, path, value).unwrap();
        self
    }
}

/// One composed server over a temporary config dir, and what it was composed with.
pub struct TestMcp {
    pub state: Arc<AdminState>,
    pub clock: Arc<TestClock>,
    pub config_dir: PathBuf,
    pub backend: Arc<LmdbBackend>,
    token: Option<String>,
    _temp: tempfile::TempDir,
}

impl TestMcp {
    /// Builds the fixture's default composition.
    pub async fn start() -> Self {
        Self::start_with(Fixture::default()).await
    }

    /// Builds a case's composition.
    pub async fn start_with(fixture: Fixture) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let config_dir = temp.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        write_settings(&config_dir, &fixture.settings);

        // `is_valid_token` refuses `expires_at <= now`, so a token minted for the second before
        // the clock is a token that has just expired.
        let token = match (fixture.token, fixture.secret.as_deref()) {
            (Token::Absent, _) | (_, None) => None,
            (Token::Valid, Some(secret)) => Some(mint(secret, now_seconds(fixture.now_ms) + 3_600)),
            (Token::Expired, Some(secret)) => Some(mint(secret, now_seconds(fixture.now_ms) - 1)),
        };

        let backend = LmdbBackend::open(temp.path().join("store")).await.unwrap();
        let backend = Arc::new(backend);
        let stores = Arc::new(ServiceStores {
            events: Arc::clone(&backend) as Arc<dyn EventRepository>,
            users: Arc::clone(&backend) as Arc<dyn nostream_storage::repositories::UserRepository>,
            invoices: Arc::clone(&backend)
                as Arc<dyn nostream_storage::repositories::InvoiceRepository>,
            nip05: Arc::clone(&backend)
                as Arc<dyn nostream_storage::repositories::Nip05VerificationRepository>,
            dvm_jobs: Arc::clone(&backend)
                as Arc<dyn nostream_storage::repositories::DvmJobRepository>,
            notification_outbox: Arc::clone(&backend)
                as Arc<dyn nostream_storage::repositories::NotificationOutboxRepository>,
            notification_delivery_log: Arc::clone(&backend)
                as Arc<dyn nostream_storage::repositories::NotificationDeliveryLogRepository>,
        });

        let client = Arc::new(ReqwestClient::new().unwrap());
        let http: Arc<dyn HttpClient> = client.clone();
        let fetch: Arc<dyn Nip05Fetch> = client;

        let clock = Arc::new(TestClock::new(fixture.now_ms));
        let state = Arc::new(AdminState::with_random(
            AdminStateConfig {
                paths: SettingsPaths::from_config_dir(&repo_root(), &config_dir),
                resources_root: resources_root(),
                secret: fixture.secret,
                stores,
                http,
                fetch,
                clock: clock.clone(),
                grafana: GrafanaSettings::default(),
                metrics_interval: std::time::Duration::from_millis(1_000),
                worker_type: "primary".to_owned(),
                worker_index: None,
                worker_count_override: Some(1),
                password_override: None,
            },
            Arc::new(SystemRandom),
        ));

        Self {
            state,
            clock,
            config_dir,
            backend,
            token,
            _temp: temp,
        }
    }

    /// A client over an in-process duplex, served by a server on the fixture's state.
    pub async fn client(&self) -> Mcp {
        self.client_with_version(env!("CARGO_PKG_VERSION")).await
    }

    /// The same, with the `serverInfo` version the composition would supply (R6).
    pub async fn client_with_version(&self, version: &str) -> Mcp {
        let server = AdminMcp::new(
            Arc::clone(&self.state),
            self.token.clone(),
            Implementation::new(MCP_SERVER_NAME, version),
        );
        let (server_io, client_io) = tokio::io::duplex(64 * 1024);
        let handle = tokio::spawn(async move {
            let service = server.serve(server_io).await.unwrap();
            service.waiting().await.unwrap();
        });
        // Pinned to a version with the `initialize` handshake, so the dialogue is the session
        // model the console's credential belongs to.
        let config = ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("nostream-mcp-tests", "0.1.0"),
        )
        .with_protocol_version(ProtocolVersion::V_2025_06_18);
        let client = config.serve(client_io).await.unwrap();
        Mcp {
            client,
            _server: handle,
        }
    }

    /// Seeds events through the store's own insert path.
    pub async fn seed(&self, records: &[EventRecord]) {
        self.backend.upsert_many(records).await.unwrap();
    }

    /// Writes the user settings document, for a case whose fixture is a file edit.
    pub fn write_settings(&self, document: &serde_yaml::Value) {
        write_settings(&self.config_dir, document);
    }

    /// The user settings document as it stands on disk.
    pub fn settings_file(&self) -> serde_yaml::Value {
        serde_yaml::from_str(
            &std::fs::read_to_string(self.config_dir.join("settings.yaml")).unwrap(),
        )
        .unwrap()
    }

    /// The `admin-audit.jsonl` entries, in file order.
    pub fn audit_entries(&self) -> Vec<Value> {
        lines(&self.config_dir.join("admin-audit.jsonl"))
    }

    /// The `settings-audit.jsonl` entries, in file order.
    pub fn settings_audit_entries(&self) -> Vec<Value> {
        lines(&self.config_dir.join("settings-audit.jsonl"))
    }

    /// The backup files `save_with_backup` left.
    pub fn backups(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(self.config_dir.join("backups")) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// The outbox rows a write enqueued, claimed the way the delivery worker claims them.
    pub async fn outbox(&self) -> Vec<nostream_storage::repositories::OutboxMessage> {
        self.state
            .stores()
            .notification_outbox
            .claim_batch(50)
            .await
            .expect("the outbox")
    }
}

/// One connected client, and the server task behind it.
pub struct Mcp {
    pub client: RunningService<RoleClient, ClientConfig>,
    _server: JoinHandle<()>,
}

impl Mcp {
    /// The `tools/list` document's tools, in the order the server returns them.
    pub async fn tools(&self) -> Vec<Tool> {
        self.client.list_tools(None).await.unwrap().tools
    }

    /// One `tools/call`, unwrapping the protocol layer.
    pub async fn call(&self, name: &str, arguments: Value) -> CallToolResult {
        self.try_call(name, arguments).await.unwrap()
    }

    /// One `tools/call` carrying no arguments at all.
    pub async fn call_without_arguments(&self, name: &str) -> CallToolResult {
        self.client
            .call_tool(CallToolRequestParams::new(name.to_owned()))
            .await
            .unwrap()
    }

    /// One `tools/call`, keeping a JSON-RPC error as an error.
    pub async fn try_call(
        &self,
        name: &str,
        arguments: Value,
    ) -> Result<CallToolResult, ServiceError> {
        self.client
            .call_tool(
                CallToolRequestParams::new(name.to_owned()).with_arguments(object(arguments)),
            )
            .await
    }
}

/// The structured payload a tool answered, which every payload assertion reads.
pub fn payload(result: &CallToolResult) -> Value {
    result
        .structured_content
        .clone()
        .expect("a tool that succeeds answers structured content")
}

/// The text a tool answered — an error result's whole message.
pub fn text(result: &CallToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|block| block.as_text())
        .map(|text| text.text.clone())
        .collect::<Vec<_>>()
        .join("")
}

/// A JSON object as the arguments type the protocol carries.
pub fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(object) => object,
        _ => panic!("arguments must be a JSON object"),
    }
}

/// A signed event of the given kind and creation time, by the key `secret`.
///
/// The store's fixture (`crates/nostream-storage/tests/parity_lmdb.rs:92-105`): the same
/// arguments twice are one event and one id, so a case that wants two rows of one kind passes
/// two different secrets.
pub fn event(secret: u8, kind: u64, created_at: i64) -> EventRecord {
    let mut event = Event {
        id: EventId::from_byte_array([0; 32]),
        pubkey: Pubkey::from_byte_array([0; 32]),
        created_at,
        kind: Kind(kind),
        tags: Vec::new(),
        content: format!("{secret}-{created_at}"),
        sig: Signature::from_byte_array([0; 64]),
    };
    nostream_core::crypto::sign_event(&[secret; 32], &mut event).expect("the event signs");
    EventRecord::from_event(&event)
}

/// The hex id a seeded record reads back as.
pub fn id_of(record: &EventRecord) -> String {
    record.event.id.to_string()
}

fn mint(secret: &[u8], expires_at: i64) -> String {
    session::create_token(&session::session_key(secret), expires_at)
}

fn now_seconds(now_ms: u64) -> i64 {
    i64::try_from(now_ms / 1_000).unwrap()
}

fn write_settings(config_dir: &Path, document: &serde_yaml::Value) {
    std::fs::write(
        config_dir.join("settings.yaml"),
        serde_yaml::to_string(document).unwrap(),
    )
    .unwrap();
}

fn lines(path: &Path) -> Vec<Value> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
