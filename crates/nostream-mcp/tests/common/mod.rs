//! The MCP test harness: `AdminState` over a temporary config dir and an LMDB store, and an
//! in-process duplex client — no child process and no port.
//!
//! The state is composed the way `crates/nostream-admin/tests/common/mod.rs:153-232` composes it,
//! minus the HTTP server: the same fixture values (`SECRET`, `PASSWORD_HASH`, `NOW_MS`), the same
//! seeding pattern (`crates/nostream-storage/tests/parity_lmdb.rs:84-92`) and the console's real
//! `resources/` tree as the schema source. The client is `rmcp`'s over `tokio::io::duplex`, which
//! is the only way to call a tool without a transport (`Peer::new` is `pub(crate)` in the SDK).
//!
//! The credential is a token file the fixture writes at mode 0600 (R27), handed to the server as
//! a [`Credential`]: a case narrows or revokes it by rewriting or deleting that file, because the
//! file's lifetime is the credential's (R29).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::StreamExt;
use nostream_admin::state::AdminStateConfig;
use nostream_admin::{AdminState, GrafanaSettings};
use nostream_config::SettingsPaths;
use nostream_core::clock::TestClock;
use nostream_core::nip05::Nip05Fetch;
use nostream_core::random::SystemRandom;
use nostream_core::{Event, EventId, Filter, Kind, Pubkey, Signature};
use nostream_mcp::{AdminMcp, Credential, MCP_SERVER_NAME, SCOPE_WRITE};
use nostream_services::{HttpClient, ReqwestClient, ServiceStores};
use nostream_storage::error::StorageError;
use nostream_storage::lmdb::LmdbBackend;
use nostream_storage::repositories::{
    EventRecord, EventRepository, QueryStream, StorageFuture, StreamedEvent,
};
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

/// The literal `SECRET` the fixture composes `AdminState` with.
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

/// The scopes the fixture's token document names.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Grant {
    /// `{"scopes": ["write"]}`: the four read tools and the three writes.
    #[default]
    Write,
    /// `{"scopes": []}`: the read tools only — the door's default (R28).
    Read,
}

impl Grant {
    fn names(self) -> &'static [&'static str] {
        match self {
            Self::Write => &[SCOPE_WRITE],
            Self::Read => &[],
        }
    }
}

/// Which store bundle the composed state reads.
#[derive(Debug, Clone, Copy, Default)]
pub enum Stores {
    /// The seeded LMDB backend: every tool's real read path.
    #[default]
    Seeded,
    /// The daemon's own unwired bundle, where every repository call reports
    /// `NotImplemented` (R19) — which tells a case what ran before the store was reached.
    Unavailable,
}

/// What a test wants built.
pub struct Fixture {
    /// The user settings document written to `<config>/settings.yaml`.
    pub settings: serde_yaml::Value,
    /// `SECRET` as a value, for the `AdminState` the tools read through.
    pub secret: Option<Vec<u8>>,
    /// The scopes the token document the server reads carries (R28).
    pub grant: Grant,
    /// The starting clock reading.
    pub now_ms: u64,
    /// The store bundle the state is composed over.
    pub stores: Stores,
    /// The report repository a case supplies in place of the backend's own.
    pub reports: Option<ReportRepositoryFactory>,
}

impl Default for Fixture {
    fn default() -> Self {
        Self {
            settings: base_settings(),
            secret: Some(SECRET.to_vec()),
            grant: Grant::Write,
            now_ms: NOW_MS,
            stores: Stores::Seeded,
            reports: None,
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

/// Builds the event repository a case wants over the harness's own backend.
pub type EventRepositoryFactory =
    Arc<dyn Fn(Arc<LmdbBackend>) -> Arc<dyn EventRepository> + Send + Sync>;

/// Builds the report repository a case wants over the harness's own backend — for a case whose
/// subject is the handler's own ordering, which a store that answers ascending cannot show.
pub type ReportRepositoryFactory = Arc<
    dyn Fn(Arc<LmdbBackend>) -> Arc<dyn nostream_storage::repositories::ReportRepository>
        + Send
        + Sync,
>;

/// One composed server over a temporary config dir, and what it was composed with.
pub struct TestMcp {
    pub state: Arc<AdminState>,
    pub clock: Arc<TestClock>,
    pub config_dir: PathBuf,
    pub backend: Arc<LmdbBackend>,
    /// The file the credential is read from on every call (R29).
    pub token_path: PathBuf,
    credential: Credential,
    _temp: tempfile::TempDir,
}

impl TestMcp {
    /// Builds the fixture's default composition.
    pub async fn start() -> Self {
        Self::start_with(Fixture::default()).await
    }

    /// Builds a case's composition.
    pub async fn start_with(fixture: Fixture) -> Self {
        Self::start_with_events(fixture, None).await
    }

    /// The same, with the event repository a case supplies in place of the backend — for the
    /// cases that need a page the store cannot be made to produce on demand, such as one whose
    /// selected key was removed before its value was read.
    pub async fn start_with_events(
        fixture: Fixture,
        events: Option<EventRepositoryFactory>,
    ) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let config_dir = temp.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        write_settings(&config_dir, &fixture.settings);

        // The document the door reads on every call (R27, R29): a case narrows it by rewriting
        // this file, which is the revocation the file form exists for.
        let token_path = write_token(&config_dir, fixture.grant.names());
        let credential = Credential::from_file(&token_path).unwrap();

        // The paths both the store and the state read: the backend is opened with the settings
        // the state serves, so the NIP-56 gate a case turns on is the gate its store applies.
        let paths = SettingsPaths::from_config_dir(&repo_root(), &config_dir);
        // The backend is always opened, so a case can seed it; when the fixture asks for the
        // daemon's bundle the state reads `unavailable::stores()` instead, and the seeded rows
        // are simply never reached.
        let backend = LmdbBackend::open(temp.path().join("store"))
            .await
            .unwrap()
            .with_settings(Arc::new(
                nostream_config::load(&paths)
                    .expect("the fixture's settings load")
                    .settings,
            ));
        let backend = Arc::new(backend);
        let stores = match fixture.stores {
            Stores::Seeded => Arc::new(ServiceStores {
                events: events.as_ref().map_or_else(
                    || Arc::clone(&backend) as Arc<dyn EventRepository>,
                    |wrap| wrap(Arc::clone(&backend)),
                ),
                users: Arc::clone(&backend)
                    as Arc<dyn nostream_storage::repositories::UserRepository>,
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
                reports: fixture.reports.as_ref().map_or_else(
                    || {
                        Arc::clone(&backend)
                            as Arc<dyn nostream_storage::repositories::ReportRepository>
                    },
                    |wrap| wrap(Arc::clone(&backend)),
                ),
            }),
            Stores::Unavailable => Arc::new(nostream_services::unavailable::stores()),
        };

        let client = Arc::new(ReqwestClient::new().unwrap());
        let http: Arc<dyn HttpClient> = client.clone();
        let fetch: Arc<dyn Nip05Fetch> = client;

        let clock = Arc::new(TestClock::new(fixture.now_ms));
        let state = Arc::new(AdminState::with_random(
            AdminStateConfig {
                paths,
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
            token_path,
            credential,
            _temp: temp,
        }
    }

    /// A client over an in-process duplex, served by a server on the fixture's state.
    pub async fn client(&self) -> Mcp {
        self.client_with_credential(self.credential.clone()).await
    }

    /// The same, with the `serverInfo` version the composition would supply (R6).
    pub async fn client_with_version(&self, version: &str) -> Mcp {
        self.client_with_version_and(version, self.credential.clone())
            .await
    }

    /// The same, with the credential a case supplies in place of the fixture's — for the
    /// descriptor-delivered document, which the mode reads once instead of per call (R29).
    pub async fn client_with_credential(&self, credential: Credential) -> Mcp {
        self.client_with_version_and(env!("CARGO_PKG_VERSION"), credential)
            .await
    }

    async fn client_with_version_and(&self, version: &str, credential: Credential) -> Mcp {
        let server = AdminMcp::new(
            Arc::clone(&self.state),
            credential,
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

    /// Rewrites the token file the running server reads on every call (R29): what the next call
    /// is decided by is what is here now, and nothing has to be restarted.
    pub fn write_scopes(&self, scopes: &[&str]) {
        write_private(&self.token_path, &token_document(scopes));
    }

    /// Deletes the token file: the credential's lifetime ends with it (R29).
    pub fn revoke(&self) {
        std::fs::remove_file(&self.token_path).unwrap();
    }

    /// A descriptor holding the same document, for the mode's other delivery form (R27).
    pub fn descriptor(&self) -> std::fs::File {
        std::fs::File::open(&self.token_path).unwrap()
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

/// The token document's text: `{"scopes": [...]}`, and `[]` for a read-only token (R27).
pub fn token_document(scopes: &[&str]) -> String {
    serde_json::to_string(&serde_json::json!({ "scopes": scopes })).unwrap()
}

/// Writes the document the door is started with, at the mode it requires (R27).
pub fn write_token(config_dir: &Path, scopes: &[&str]) -> PathBuf {
    let path = config_dir.join("admin-token.json");
    write_private(&path, &token_document(scopes));
    path
}

/// Writes `contents` to `path` at mode `0600`, which satisfies the token document's rule — no
/// group or other permission — so no case is refused at start for its mode (R27).
pub fn write_private(path: &Path, contents: &str) {
    use std::os::unix::fs::PermissionsExt;

    std::fs::write(path, contents).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
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

/// The real backend, with one page slot reported as vanished.
///
/// `StreamedEvent::Vanished` is what the LMDB stream emits for a key it selected and could not
/// read — a replacement hard-deletes the row it supersedes and a retention pass removes a
/// soft-deleted one, and both can land between the selection and the batch read. That window
/// cannot be opened from outside the store, so a case that needs the marker takes a real page
/// and has the `nth` record inside it answered as the marker instead. Every other method is the
/// backend's own.
pub struct VanishingRepository {
    inner: Arc<LmdbBackend>,
    nth: usize,
}

impl VanishingRepository {
    /// The backend, with the `nth` record of every page reported as vanished.
    pub fn new(inner: Arc<LmdbBackend>, nth: usize) -> Self {
        Self { inner, nth }
    }
}

impl EventRepository for VanishingRepository {
    fn create<'a>(&'a self, record: &'a EventRecord) -> StorageFuture<'a, u64> {
        self.inner.create(record)
    }

    fn create_many<'a>(&'a self, records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
        self.inner.create_many(records)
    }

    fn upsert<'a>(&'a self, record: &'a EventRecord) -> StorageFuture<'a, u64> {
        self.inner.upsert(record)
    }

    fn upsert_many<'a>(&'a self, records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
        self.inner.upsert_many(records)
    }

    fn find_by_filters<'a>(
        &'a self,
        filters: &'a [Filter],
    ) -> StorageFuture<'a, QueryStream<'a, StreamedEvent>> {
        Box::pin(async move {
            let stream = self.inner.find_by_filters(filters).await?;
            let items: Vec<Result<StreamedEvent, StorageError>> = stream.collect().await;
            let nth = self.nth;
            let mut seen = 0usize;
            let mapped = items.into_iter().map(move |item| {
                item.map(|event| match event {
                    StreamedEvent::Record(record) => {
                        seen += 1;
                        if seen == nth {
                            StreamedEvent::Vanished
                        } else {
                            StreamedEvent::Record(record)
                        }
                    }
                    marker => marker,
                })
            });
            Ok(Box::pin(futures_util::stream::iter(mapped)) as QueryStream<'a, StreamedEvent>)
        })
    }

    fn count_by_filters<'a>(&'a self, filters: &'a [Filter]) -> StorageFuture<'a, u64> {
        self.inner.count_by_filters(filters)
    }

    fn page_bound(&self) -> u64 {
        self.inner.page_bound()
    }

    fn search_rule(&self) -> nostream_storage::repositories::SearchRule {
        self.inner.search_rule()
    }

    fn empty_tag_rule(&self) -> nostream_storage::repositories::EmptyTagRule {
        self.inner.empty_tag_rule()
    }

    fn find_reconciliation_items<'a>(
        &'a self,
        filter: &'a Filter,
    ) -> StorageFuture<'a, QueryStream<'a, nostream_storage::repositories::ReconciliationItem>>
    {
        self.inner.find_reconciliation_items(filter)
    }

    fn delete_by_pubkey_and_ids<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        ids: &'a [EventId],
    ) -> StorageFuture<'a, u64> {
        self.inner.delete_by_pubkey_and_ids(pubkey, ids)
    }

    fn delete_by_addresses<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        addresses: &'a [(Kind, String)],
        not_after: i64,
    ) -> StorageFuture<'a, u64> {
        self.inner.delete_by_addresses(pubkey, addresses, not_after)
    }

    fn delete_by_pubkey_except_kinds<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        excluded_kinds: &'a [Kind],
    ) -> StorageFuture<'a, u64> {
        self.inner
            .delete_by_pubkey_except_kinds(pubkey, excluded_kinds)
    }

    fn has_active_request_to_vanish<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        self.inner.has_active_request_to_vanish(pubkey)
    }

    fn delete_expired_and_retained<'a>(
        &'a self,
        options: &'a nostream_storage::repositories::EventRetentionOptions,
    ) -> StorageFuture<'a, nostream_storage::repositories::EventPurgeCounts> {
        self.inner.delete_expired_and_retained(options)
    }

    fn scan_live<'a>(
        &'a self,
        after: Option<nostream_storage::repositories::ScanCursor>,
        limit: u64,
    ) -> StorageFuture<'a, QueryStream<'a, nostream_storage::repositories::EventRecord>> {
        self.inner.scan_live(after, limit)
    }

    fn count_by_criteria<'a>(
        &'a self,
        criteria: &'a nostream_storage::repositories::EventCleanCriteria,
    ) -> StorageFuture<'a, u64> {
        self.inner.count_by_criteria(criteria)
    }

    fn delete_by_criteria<'a>(
        &'a self,
        criteria: &'a nostream_storage::repositories::EventCleanCriteria,
    ) -> StorageFuture<'a, u64> {
        self.inner.delete_by_criteria(criteria)
    }

    fn delete_all_events(&self) -> StorageFuture<'_, ()> {
        self.inner.delete_all_events()
    }
}
