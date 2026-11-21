//! The admin test harness: one in-process server over a temporary config dir and an LMDB
//! store, plus a hand-written HTTP/1.1 client over `tokio::net::TcpStream` (D11 —
//! `reqwest` is confined to `nostream-services`).
//!
//! Every target starts from [`TestServer::start`]: a written `settings.yaml` with
//! `admin.enabled: true`, the fixture password hash, `info.relay_url` and (when a case needs
//! them) the limiter blocks; the shipped `resources/default-settings.yaml` as the schema; the
//! console's real `resources/admin` tree; `SECRET` as a literal; `LmdbBackend::open(tempdir)`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use nostream_admin::state::AdminStateConfig;
use nostream_admin::{AdminState, GrafanaSettings};
use nostream_config::{SettingsPaths, load_defaults};
use nostream_core::clock::{Clock, TestClock};
use nostream_core::nip05::Nip05Fetch;
use nostream_core::random::SystemRandom;
use nostream_services::{HttpClient, ReqwestClient, ServiceStores};
use nostream_storage::lmdb::LmdbBackend;
use nostream_storage::repositories::{
    DeliveryLogEntry, DeliveryLogFilters, EventRecord, EventRepository, QueryStream, SearchRule,
    StreamedEvent,
};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;

/// The repository root, from the crate's manifest directory.
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The resources root the console is served from.
pub fn resources_root() -> PathBuf {
    repo_root().join("resources")
}

/// The fixture password and the `scrypt:` hash `hashAdminPassword` writes for it with a
/// 16-byte salt of `0x07` (Node's defaults: N=16384, r=8, p=1, 64-byte key).
pub const PASSWORD: &str = "hunter2";
pub const PASSWORD_HASH: &str = "scrypt:BwcHBwcHBwcHBwcHBwcHBw==:r5daXU05UJ9EUDu45YoHMWUoQCmkVbwINYNntY1/dwrJPOt3fTi/1IWw1wp9+YXRj1Vm6IpFi+gSU0JdqZvWIw==";

/// The literal `SECRET` the fixture signs sessions with.
pub const SECRET: &[u8] = b"a-test-secret";

/// The clock the fixture starts at (`TestClock::new(1_700_000_000_000)`).
pub const NOW_MS: u64 = 1_700_000_000_000;

/// The storage-count deadline (`ADMIN_OPS_STORAGE_QUERY_TIMEOUT_MS`, Value 22).
pub const STORAGE_TIMEOUT_MS: u64 = 5_000;

/// What a test wants built. The defaults are the console's happy path; a case overrides the
/// settings document, the password override, the store or the clock.
pub struct Fixture {
    /// The user settings document written to `<config>/settings.yaml`.
    pub settings: serde_yaml::Value,
    /// `SECRET` as a value; `None` is the missing-secret case.
    pub secret: Option<Vec<u8>>,
    /// `ADMIN_PASSWORD`, when the case sets the override.
    pub password_override: Option<String>,
    /// The event store; `None` opens an LMDB store in the temp dir.
    pub events: Option<Arc<dyn EventRepository>>,
    /// The starting clock reading.
    pub now_ms: u64,
    /// The metrics frame interval.
    pub metrics_interval: Duration,
    /// A worker count override (`WORKER_COUNT`).
    pub worker_count: Option<u32>,
    /// The nip05 repository, when a case needs its own.
    pub nip05: Option<Arc<dyn nostream_storage::repositories::Nip05VerificationRepository>>,
    /// The delivery-log repository, when a case needs rows.
    pub delivery_log:
        Option<Arc<dyn nostream_storage::repositories::NotificationDeliveryLogRepository>>,
    /// The NIP-05 fetch seam, when a case scripts the verification outcome.
    pub fetch: Option<Arc<dyn Nip05Fetch>>,
}

impl Default for Fixture {
    fn default() -> Self {
        Self {
            settings: base_settings(),
            secret: Some(SECRET.to_vec()),
            password_override: None,
            events: None,
            now_ms: NOW_MS,
            metrics_interval: Duration::from_millis(1_000),
            worker_count: Some(1),
            nip05: None,
            delivery_log: None,
            fetch: None,
        }
    }
}

impl Fixture {
    /// The base settings with one path replaced, using the settings schema's own dot-path
    /// writer.
    pub fn with(mut self, path: &str, value: serde_json::Value) -> Self {
        let value: serde_yaml::Value = serde_yaml::from_str(&value.to_string()).unwrap();
        self.settings = nostream_config::path::set_by_path(&self.settings, path, value).unwrap();
        self
    }
}

/// The console's happy-path settings: the surface on, the fixture hash, no path prefix, and
/// limiter windows generous enough that a case driving the whole surface never trips them.
/// `settings_with_limiters` is the strict, shipped-numbers block `rate_limit` uses.
pub fn base_settings() -> serde_yaml::Value {
    serde_yaml::from_str(&format!(
        "info:\n  name: Example\n  relay_url: wss://relay.example\nadmin:\n  enabled: true\n  passwordHash: \"{PASSWORD_HASH}\"\nlimits:\n  admin:\n    rateLimits:\n      - period: 60000\n        rate: 100000\n    loginRateLimits:\n      - period: 900000\n        rate: 100000\n    ipWhitelist: []\n"
    ))
    .unwrap()
}

/// The settings with the default-settings limiter blocks spelled out, so a case that needs
/// the limiters does not depend on the shipped defaults.
pub fn settings_with_limiters() -> serde_yaml::Value {
    serde_yaml::from_str(&format!(
        "info:\n  name: Example\n  relay_url: wss://relay.example\nadmin:\n  enabled: true\n  passwordHash: \"{PASSWORD_HASH}\"\nlimits:\n  admin:\n    rateLimits:\n      - period: 60000\n        rate: 30\n    loginRateLimits:\n      - period: 900000\n        rate: 10\n    ipWhitelist:\n      - \"::1\"\n      - 10.10.10.1\n      - \"::ffff:10.10.10.1\"\n"
    ))
    .unwrap()
}

/// One running server over a temporary config dir.
pub struct TestServer {
    pub addr: SocketAddr,
    pub state: Arc<AdminState>,
    pub clock: Arc<TestClock>,
    pub config_dir: PathBuf,
    _temp: tempfile::TempDir,
    handle: JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

impl TestServer {
    /// Starts the surface with the default fixture.
    pub async fn start() -> Self {
        Self::start_with(Fixture::default()).await
    }

    /// Starts the surface with a case's fixture.
    pub async fn start_with(fixture: Fixture) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let config_dir = temp.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("settings.yaml"),
            serde_yaml::to_string(&fixture.settings).unwrap(),
        )
        .unwrap();

        let backend = LmdbBackend::open(temp.path().join("store")).await.unwrap();
        let backend = Arc::new(backend);
        let events: Arc<dyn EventRepository> = fixture
            .events
            .unwrap_or_else(|| Arc::clone(&backend) as Arc<dyn EventRepository>);
        let stores = Arc::new(ServiceStores {
            events,
            users: Arc::clone(&backend) as Arc<dyn nostream_storage::repositories::UserRepository>,
            invoices: Arc::clone(&backend)
                as Arc<dyn nostream_storage::repositories::InvoiceRepository>,
            nip05: fixture.nip05.unwrap_or_else(|| {
                Arc::clone(&backend)
                    as Arc<dyn nostream_storage::repositories::Nip05VerificationRepository>
            }),
            dvm_jobs: Arc::clone(&backend)
                as Arc<dyn nostream_storage::repositories::DvmJobRepository>,
            notification_outbox: Arc::clone(&backend)
                as Arc<dyn nostream_storage::repositories::NotificationOutboxRepository>,
            notification_delivery_log: fixture.delivery_log.unwrap_or_else(|| {
                Arc::clone(&backend)
                    as Arc<dyn nostream_storage::repositories::NotificationDeliveryLogRepository>
            }),
            reports: Arc::clone(&backend)
                as Arc<dyn nostream_storage::repositories::ReportRepository>,
        });

        let client = Arc::new(ReqwestClient::new().unwrap());
        let http: Arc<dyn HttpClient> = client.clone();
        let fetch: Arc<dyn Nip05Fetch> = fixture.fetch.unwrap_or(client as Arc<dyn Nip05Fetch>);

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
                metrics_interval: fixture.metrics_interval,
                worker_type: "primary".to_owned(),
                worker_index: None,
                worker_count_override: fixture.worker_count,
                password_override: fixture.password_override,
            },
            Arc::new(SystemRandom),
        ));

        let router = nostream_admin::mount(Arc::clone(&state));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        Self {
            addr,
            state,
            clock,
            config_dir,
            _temp: temp,
            handle,
        }
    }

    /// Logs in and returns the `Cookie` header value the session rides in.
    pub async fn login(&self) -> String {
        let response = self
            .request(
                "POST",
                "/admin/login",
                &[("content-type", "application/json")],
                Some(format!("{{\"password\":\"{PASSWORD}\"}}").as_bytes()),
            )
            .await;
        assert_eq!(response.status, 200, "login: {}", response.text());
        let cookie = response.header("set-cookie").expect("a session cookie");
        cookie
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_owned()
    }

    /// One request, no session.
    pub async fn get(&self, path: &str) -> Response {
        self.request("GET", path, &[], None).await
    }

    /// One request carrying the session cookie.
    pub async fn get_with(&self, path: &str, cookie: &str) -> Response {
        self.request("GET", path, &[("cookie", cookie)], None).await
    }

    /// A JSON request carrying the session cookie.
    pub async fn send_json(&self, method: &str, path: &str, cookie: &str, body: Value) -> Response {
        self.request(
            method,
            path,
            &[("cookie", cookie), ("content-type", "application/json")],
            Some(body.to_string().as_bytes()),
        )
        .await
    }

    /// One hand-written HTTP/1.1 request.
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Response {
        let mut stream = TcpStream::connect(self.addr).await.expect("connect");
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n",
            self.addr.port()
        );
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        let body = body.unwrap_or_default();
        if !body.is_empty() {
            request.push_str(&format!("content-length: {}\r\n", body.len()));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        stream.write_all(body).await.unwrap();
        stream.flush().await.unwrap();

        read_response(&mut stream).await
    }
}

/// One parsed response.
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|error| panic!("not JSON ({error}): {}", self.text()))
    }

    /// The body's object keys, sorted.
    pub fn keys(&self) -> Vec<String> {
        let value = self.json();
        let mut keys: Vec<String> = match value {
            Value::Object(object) => object.keys().cloned().collect(),
            other => panic!("expected an object, got {other}"),
        };
        keys.sort();
        keys
    }

    pub fn content_type(&self) -> &str {
        self.header("content-type").unwrap_or_default()
    }
}

/// Reads and parses one HTTP/1.1 response (content-length or chunked).
pub async fn read_response(stream: &mut TcpStream) -> Response {
    let head = read_head(stream).await;
    let (status, headers) = parse_head(&head);
    let body = read_body(stream, &headers).await;
    Response {
        status,
        headers,
        body,
    }
}

/// Reads the response head, byte by byte up to the blank line.
pub async fn read_head(stream: &mut TcpStream) -> Vec<u8> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let read = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut byte))
            .await
            .expect("a response head within ten seconds")
            .expect("read");
        if read == 0 {
            break;
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    head
}

/// Parses a head into its status code and headers.
pub fn parse_head(head: &[u8]) -> (u16, Vec<(String, String)>) {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_owned(), value.trim().to_owned()));
        }
    }
    (status, headers)
}

/// Reads a body per its headers.
pub async fn read_body(stream: &mut TcpStream, headers: &[(String, String)]) -> Vec<u8> {
    let header = |name: &str| {
        headers
            .iter()
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    };

    if header("transfer-encoding").is_some_and(|value| value.contains("chunked")) {
        return read_chunked(stream).await;
    }

    if let Some(length) = header("content-length").and_then(|value| value.parse::<usize>().ok()) {
        let mut body = vec![0u8; length];
        stream
            .read_exact(&mut body)
            .await
            .expect("the declared body");
        return body;
    }

    let mut body = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut body)).await;
    body
}

/// Decodes a chunked body, giving up when the stream goes quiet: an SSE stream never ends, and
/// a case that drives every route must not wait for one.
async fn read_chunked(stream: &mut TcpStream) -> Vec<u8> {
    let idle = Duration::from_millis(500);
    let mut body = Vec::new();
    loop {
        let mut size_line = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            let Ok(Ok(read)) = tokio::time::timeout(idle, stream.read(&mut byte)).await else {
                return body;
            };
            if read == 0 {
                return body;
            }
            size_line.push(byte[0]);
            if size_line.ends_with(b"\r\n") {
                break;
            }
        }
        let size_text = String::from_utf8_lossy(&size_line);
        let size = usize::from_str_radix(size_text.trim(), 16).unwrap_or(0);
        if size == 0 {
            return body;
        }
        let mut chunk = vec![0u8; size];
        if tokio::time::timeout(idle, stream.read_exact(&mut chunk))
            .await
            .is_err()
        {
            return body;
        }
        body.extend_from_slice(&chunk);
        let mut trailer = [0u8; 2];
        if tokio::time::timeout(idle, stream.read_exact(&mut trailer))
            .await
            .is_err()
        {
            return body;
        }
    }
}

/// An event store whose `count_by_filters` outlives any deadline (or fails outright); every
/// other call is `NotImplemented`. Enough for the `504`/`500` branches, and honest about what
/// it is.
#[derive(Debug)]
pub struct SlowEventRepository {
    pub delay: Duration,
    pub fail: bool,
}

impl EventRepository for SlowEventRepository {
    fn create<'a>(
        &'a self,
        _record: &'a EventRecord,
    ) -> nostream_storage::repositories::StorageFuture<'a, u64> {
        Box::pin(async { Err(not_implemented()) })
    }

    fn create_many<'a>(
        &'a self,
        _records: &'a [EventRecord],
    ) -> nostream_storage::repositories::StorageFuture<'a, u64> {
        Box::pin(async { Err(not_implemented()) })
    }

    fn upsert<'a>(
        &'a self,
        _record: &'a EventRecord,
    ) -> nostream_storage::repositories::StorageFuture<'a, u64> {
        Box::pin(async { Err(not_implemented()) })
    }

    fn upsert_many<'a>(
        &'a self,
        _records: &'a [EventRecord],
    ) -> nostream_storage::repositories::StorageFuture<'a, u64> {
        Box::pin(async { Err(not_implemented()) })
    }

    fn find_by_filters<'a>(
        &'a self,
        _filters: &'a [nostream_core::Filter],
    ) -> nostream_storage::repositories::StorageFuture<'a, QueryStream<'a, StreamedEvent>> {
        Box::pin(async { Err(not_implemented()) })
    }

    fn count_by_filters<'a>(
        &'a self,
        _filters: &'a [nostream_core::Filter],
    ) -> nostream_storage::repositories::StorageFuture<'a, u64> {
        Box::pin(async move {
            tokio::time::sleep(self.delay).await;
            if self.fail {
                return Err(not_implemented());
            }
            Ok(0)
        })
    }

    fn find_reconciliation_items<'a>(
        &'a self,
        _filter: &'a nostream_core::Filter,
    ) -> nostream_storage::repositories::StorageFuture<
        'a,
        QueryStream<'a, nostream_storage::repositories::ReconciliationItem>,
    > {
        Box::pin(async { Err(not_implemented()) })
    }

    fn find_stored<'a>(
        &'a self,
        _id: &'a nostream_core::EventId,
    ) -> nostream_storage::repositories::StorageFuture<'a, Option<EventRecord>> {
        Box::pin(async { Err(not_implemented()) })
    }

    fn delete_by_pubkey_and_ids<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
        _ids: &'a [nostream_core::EventId],
    ) -> nostream_storage::repositories::StorageFuture<'a, u64> {
        Box::pin(async { Err(not_implemented()) })
    }

    fn delete_by_addresses<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
        _addresses: &'a [(nostream_core::Kind, String)],
        _not_after: i64,
    ) -> nostream_storage::repositories::StorageFuture<'a, u64> {
        Box::pin(async { Err(not_implemented()) })
    }

    fn delete_by_pubkey_except_kinds<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
        _excluded_kinds: &'a [nostream_core::Kind],
    ) -> nostream_storage::repositories::StorageFuture<'a, u64> {
        Box::pin(async { Err(not_implemented()) })
    }

    fn has_active_request_to_vanish<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
    ) -> nostream_storage::repositories::StorageFuture<'a, bool> {
        Box::pin(async { Err(not_implemented()) })
    }

    fn delete_expired_and_retained<'a>(
        &'a self,
        _options: &'a nostream_storage::repositories::EventRetentionOptions,
    ) -> nostream_storage::repositories::StorageFuture<
        'a,
        nostream_storage::repositories::EventPurgeCounts,
    > {
        Box::pin(async { Err(not_implemented()) })
    }

    fn scan_live<'a>(
        &'a self,
        _after: Option<nostream_storage::repositories::ScanCursor>,
        _limit: u64,
    ) -> nostream_storage::repositories::StorageFuture<
        'a,
        QueryStream<'a, nostream_storage::repositories::EventRecord>,
    > {
        Box::pin(async { Err(not_implemented()) })
    }

    fn count_by_criteria<'a>(
        &'a self,
        _criteria: &'a nostream_storage::repositories::EventCleanCriteria,
    ) -> nostream_storage::repositories::StorageFuture<'a, u64> {
        Box::pin(async { Err(not_implemented()) })
    }

    fn delete_by_criteria<'a>(
        &'a self,
        _criteria: &'a nostream_storage::repositories::EventCleanCriteria,
    ) -> nostream_storage::repositories::StorageFuture<'a, u64> {
        Box::pin(async { Err(not_implemented()) })
    }

    fn delete_all_events(&self) -> nostream_storage::repositories::StorageFuture<'_, ()> {
        Box::pin(async { Err(not_implemented()) })
    }

    fn page_bound(&self) -> u64 {
        nostream_storage::MAX_PAGE_ROWS
    }

    fn search_rule(&self) -> SearchRule {
        SearchRule::SubstringTerms
    }
}

fn not_implemented() -> nostream_storage::StorageError {
    nostream_storage::StorageError::NotImplemented {
        module: "nostream-admin::tests::SlowEventRepository",
    }
}

/// Inserts one delivery-log row through the real store.
pub async fn seed_delivery_log(
    server: &TestServer,
    event_type: &str,
    status: nostream_storage::repositories::NotificationDeliveryStatus,
) {
    let entry = nostream_storage::repositories::NewDeliveryLogEntry {
        outbox_id: None,
        event_type: event_type.to_owned(),
        target_id: "target-1".to_owned(),
        target_type: nostream_storage::repositories::NotificationTargetType::Http,
        status,
        attempt_number: 1,
        error_snippet: None,
    };
    server
        .state
        .stores()
        .notification_delivery_log
        .append(&entry)
        .await
        .unwrap();
}

/// The delivery-log rows the store holds, for a case that asserts a seeded row is listed.
pub async fn delivery_log_rows(server: &TestServer, limit: u64) -> Vec<DeliveryLogEntry> {
    let filters = DeliveryLogFilters::default();
    server
        .state
        .stores()
        .notification_delivery_log
        .find_recent(limit, &filters)
        .await
        .unwrap_or_default()
}

/// The clock reading as whole seconds.
pub fn now_seconds(clock: &TestClock) -> i64 {
    clock.now_secs()
}

/// Advances the clock, so a rate-limit window or a token expiry can cross.
pub fn advance(clock: &TestClock, millis: u64) {
    clock.advance(millis);
}

/// The shipped defaults document, for a case that asserts against it.
pub fn defaults_document() -> serde_yaml::Value {
    load_defaults(&resources_root().join("default-settings.yaml")).unwrap()
}

/// A run-unique temporary directory for a case that needs files of its own.
pub fn temp_dir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}
