//! The state every admin handler is handed: where the settings live, the shared secret, the
//! repository bundle, the HTTP and NIP-05 seams, the clock, the resources root, and the
//! process-local tables that replace the capture's Redis (ADR 0010's assignment, decision D2).
//!
//! Settings are **read per request** (D8): the capture's `loadMergedSettings()` re-reads the
//! files on every call, and a per-request read makes the console's own view correct after a
//! `PATCH` with no shared mutable cache.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nostream_config::{
    Issue, Settings, SettingsPaths, fit, load_defaults, load_user_settings, merge,
};
use nostream_core::Clock;
use nostream_core::nip05::Nip05Fetch;
use nostream_core::random::{RandomSource, SystemRandom};
use nostream_services::{HttpClient, ServiceStores};
use serde::Serialize;
use serde_json::Value;

use crate::error::AdminError;

/// The heartbeat TTL every monitored row is judged against (`ADMIN_OPS_HEARTBEAT_TTL_SECONDS`,
/// `src/utils/admin-ops-store.ts:9`).
pub const HEARTBEAT_TTL_SECONDS: u64 = 120;

/// How often the daemon republishes the `maintenance` heartbeat
/// (`ADMIN_OPS_HEARTBEAT_INTERVAL_MS`).
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(45_000);

/// The stored admin audit entries (`MAX_ADMIN_AUDIT_ENTRIES`).
pub const MAX_AUDIT_ENTRIES: usize = 2_000;

/// The outbox event type a settings write enqueues (`OperatorNotificationEventType.SETTINGS_CHANGED`).
pub const SETTINGS_CHANGED: &str = "settings.changed";

/// One worker heartbeat (`AdminOpsWorkerHeartbeat`, `src/@types/admin-ops.ts:1-8`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerHeartbeat {
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub updated_at: String,
}

impl WorkerHeartbeat {
    /// The capture's row key: `type:index`, or the bare type when there is no index.
    pub fn key(&self) -> String {
        heartbeat_key(&self.r#type, self.index.as_deref())
    }
}

/// `heartbeatKey` (`src/utils/admin-ops-config.ts:74-75`).
pub fn heartbeat_key(worker_type: &str, index: Option<&str>) -> String {
    match index {
        Some(index) if !index.is_empty() => format!("{worker_type}:{index}"),
        _ => worker_type.to_owned(),
    }
}

/// One probe run kept in the history ring (D3: nothing records one in this slice, and the
/// ring exists so #865's run lands in the shape the console reads).
#[derive(Debug, Clone)]
struct ProbeRun {
    at_ms: u64,
    snapshot: Value,
}

/// The probe snapshot and its bounded history (`RelayProbeHistoryStore`).
#[derive(Debug, Default)]
struct ProbeState {
    latest: Option<Value>,
    runs: VecDeque<ProbeRun>,
}

/// What one `AdminState` keeps in process, replacing the capture's Redis keys (D2).
#[derive(Debug, Default)]
pub struct AdminRuntime {
    heartbeats: Mutex<HashMap<String, WorkerHeartbeat>>,
    probe: Mutex<ProbeState>,
    audit: Mutex<()>,
    /// `<key>:admin-<scope>:<period>` → the hit timestamps inside the window, in ms.
    limiter: Mutex<HashMap<String, VecDeque<u64>>>,
}

impl std::fmt::Debug for AdminState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AdminState")
            .field("paths", &self.paths)
            .field("resources_root", &self.resources_root)
            .field("secret", &self.secret.as_ref().map(|_| "***"))
            .finish_non_exhaustive()
    }
}

/// What the composition root hands [`AdminState::new`].
pub struct AdminStateConfig {
    /// Where the settings files live (`SettingsPaths`).
    pub paths: SettingsPaths,
    /// The directory holding `admin/dashboard.html` and `admin/assets` — `resources`.
    pub resources_root: PathBuf,
    /// `SECRET` as a value. `None` means the environment had none, which makes login and
    /// session minting answer `500` rather than guess.
    pub secret: Option<Vec<u8>>,
    /// The repository bundle the relay and services already share (D7).
    pub stores: Arc<ServiceStores>,
    /// The outbound HTTP seam (`deliver_to_target`).
    pub http: Arc<dyn HttpClient>,
    /// The NIP-05 fetch seam (`nostream_core::nip05::verify`).
    pub fetch: Arc<dyn Nip05Fetch>,
    /// The one clock; `TestClock` in the admin's tests.
    pub clock: Arc<dyn Clock>,
    /// The Grafana link settings the page template carries (Value 44), resolved from the
    /// environment by the composition root.
    pub grafana: GrafanaSettings,
    /// The metrics stream's interval (Value 27), resolved from
    /// `ADMIN_METRICS_SSE_INTERVAL_MS` by the composition root.
    pub metrics_interval: Duration,
    /// The health snapshot's worker identity (`WORKER_TYPE` / `WORKER_INDEX`).
    pub worker_type: String,
    /// The health snapshot's worker index, when the process has one.
    pub worker_index: Option<String>,
    /// `WORKER_COUNT`, when the operator set it (Value 40).
    pub worker_count_override: Option<u32>,
    /// `ADMIN_PASSWORD` when the environment set a non-empty one (Value 10).
    pub password_override: Option<String>,
}

/// The Grafana links the dashboard template substitutes (`src/utils/admin-grafana.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrafanaSettings {
    pub base_url: String,
    pub dashboard_uid: String,
}

impl Default for GrafanaSettings {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:7777".to_owned(),
            dashboard_uid: "nostream-overview".to_owned(),
        }
    }
}

/// The admin surface's state.
pub struct AdminState {
    paths: SettingsPaths,
    resources_root: PathBuf,
    secret: Option<Vec<u8>>,
    stores: Arc<ServiceStores>,
    http: Arc<dyn HttpClient>,
    fetch: Arc<dyn Nip05Fetch>,
    clock: Arc<dyn Clock>,
    random: Arc<dyn RandomSource>,
    runtime: AdminRuntime,
    started_ms: u64,
    grafana: GrafanaSettings,
    metrics_interval: Duration,
    worker_type: String,
    worker_index: Option<String>,
    worker_count_override: Option<u32>,
    password_override: Option<String>,
}

impl AdminState {
    /// Builds the state and starts the clock-derived uptime.
    pub fn new(config: AdminStateConfig) -> Self {
        Self::with_random(config, Arc::new(SystemRandom))
    }

    /// Builds the state with an explicit randomness source.
    pub fn with_random(config: AdminStateConfig, random: Arc<dyn RandomSource>) -> Self {
        let started_ms = config.clock.now_ms();
        Self {
            paths: config.paths,
            resources_root: config.resources_root,
            secret: config.secret,
            stores: config.stores,
            http: config.http,
            fetch: config.fetch,
            clock: config.clock,
            random,
            runtime: AdminRuntime::default(),
            started_ms,
            grafana: config.grafana,
            metrics_interval: config.metrics_interval,
            worker_type: config.worker_type,
            worker_index: config.worker_index,
            worker_count_override: config.worker_count_override,
            password_override: config.password_override,
        }
    }

    /// The resolved settings paths.
    pub fn paths(&self) -> &SettingsPaths {
        &self.paths
    }

    /// The resources root (`resources`).
    pub fn resources_root(&self) -> &Path {
        &self.resources_root
    }

    /// The dashboard template.
    pub fn dashboard_path(&self) -> PathBuf {
        self.resources_root.join("admin").join("dashboard.html")
    }

    /// The assets directory.
    pub fn assets_dir(&self) -> PathBuf {
        self.resources_root.join("admin").join("assets")
    }

    /// The session secret, if the environment carried one.
    pub fn secret(&self) -> Option<&[u8]> {
        self.secret.as_deref()
    }

    /// The repository bundle.
    pub fn stores(&self) -> &Arc<ServiceStores> {
        &self.stores
    }

    /// The outbound HTTP seam.
    pub fn http(&self) -> &Arc<dyn HttpClient> {
        &self.http
    }

    /// The NIP-05 fetch seam.
    pub fn fetch(&self) -> &dyn Nip05Fetch {
        self.fetch.as_ref()
    }

    /// The process clock.
    pub fn clock(&self) -> &Arc<dyn Clock> {
        &self.clock
    }

    /// The randomness source.
    pub fn random(&self) -> &Arc<dyn RandomSource> {
        &self.random
    }

    /// The Grafana link settings.
    pub fn grafana(&self) -> &GrafanaSettings {
        &self.grafana
    }

    /// The metrics stream's interval.
    pub fn metrics_interval(&self) -> Duration {
        self.metrics_interval
    }

    /// The health snapshot's worker identity.
    pub fn worker_identity(&self) -> (&str, Option<&str>) {
        (&self.worker_type, self.worker_index.as_deref())
    }

    /// `ADMIN_PASSWORD`, when the environment set a non-empty one.
    pub fn password_override(&self) -> Option<&str> {
        self.password_override.as_deref()
    }

    /// `WORKER_COUNT`, when the operator set it.
    pub fn worker_count_override(&self) -> Option<u32> {
        self.worker_count_override
    }

    /// The process-local tables.
    pub fn runtime(&self) -> &AdminRuntime {
        &self.runtime
    }

    /// The admin audit file: `<config>/admin-audit.jsonl` (D9).
    pub fn audit_log_path(&self) -> PathBuf {
        self.paths.config_base_dir.join("admin-audit.jsonl")
    }

    /// Whole seconds since the state was built (`process.uptime()` in the capture).
    pub fn uptime_seconds(&self) -> u64 {
        self.clock.now_ms().saturating_sub(self.started_ms) / 1000
    }

    /// The defaults document.
    pub fn defaults_document(&self) -> Result<serde_yaml::Value, AdminError> {
        Ok(load_defaults(&self.paths.default_settings_file)?)
    }

    /// The user's overrides (empty when there are none).
    pub fn user_document(&self) -> Result<serde_yaml::Value, AdminError> {
        Ok(load_user_settings(&self.paths.config_base_dir)?
            .unwrap_or(serde_yaml::Value::Mapping(Default::default())))
    }

    /// The merged, validated settings, read per request (D8).
    pub fn settings(&self) -> Result<Settings, AdminError> {
        let defaults = self.defaults_document()?;
        let user = self.user_document()?;
        let merged = merge(&defaults, &user);
        log_issues(&validate_merged(&merged, &defaults));
        if let Ok(settings) = fit(&merged, &defaults) {
            return Ok(settings);
        }
        fit(&defaults, &defaults)
            .map_err(|issue| AdminError::Internal(format!("settings do not fit: {issue}")))
    }

    /// The merged settings document and the defaults it was merged from.
    pub fn merged_document(&self) -> Result<(serde_yaml::Value, serde_yaml::Value), AdminError> {
        let defaults = self.defaults_document()?;
        let user = self.user_document()?;
        Ok((merge(&defaults, &user), defaults))
    }

    /// The path prefix the surface is mounted at, from `info.relay_url` (D10).
    pub fn path_prefix(&self) -> String {
        match self.settings() {
            Ok(settings) => {
                crate::utils::http::path_prefix_from_relay_url(&settings.info.relay_url)
            }
            Err(error) => {
                tracing::warn!(error = %error, "the admin surface fell back to an empty path prefix");
                String::new()
            }
        }
    }

    /// Publishes one worker heartbeat, stamped by the clock.
    pub fn publish_heartbeat(&self, worker_type: &str, index: Option<&str>) {
        let now = iso8601(self.clock.now_ms());
        let heartbeat = WorkerHeartbeat {
            r#type: worker_type.to_owned(),
            index: index.map(str::to_owned),
            last_run_started_at: None,
            last_run_finished_at: None,
            last_error: None,
            updated_at: now,
        };
        self.runtime
            .heartbeats
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(heartbeat.key(), heartbeat);
    }

    /// The published heartbeats.
    pub fn heartbeats(&self) -> Vec<WorkerHeartbeat> {
        self.runtime
            .heartbeats
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect()
    }

    /// The latest probe snapshot, if a run recorded one.
    pub fn latest_probe_snapshot(&self) -> Option<Value> {
        self.runtime
            .probe
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .latest
            .clone()
    }

    /// The probe history, newest first, bounded by the settings' retention.
    pub fn probe_history(&self, limit: usize, retention: ProbeRetention) -> Vec<Value> {
        let now = self.clock.now_ms();
        let mut state = self
            .runtime
            .probe
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.trim(retention, now);
        state
            .runs
            .iter()
            .rev()
            .take(limit)
            .map(|run| run.snapshot.clone())
            .collect()
    }

    /// Records one probe run as the latest snapshot and appends it to the ring.
    pub fn record_probe_run(&self, snapshot: Value, retention: ProbeRetention) {
        let now = self.clock.now_ms();
        let mut state = self
            .runtime
            .probe
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.latest = Some(snapshot.clone());
        state.runs.push_back(ProbeRun {
            at_ms: now,
            snapshot,
        });
        state.trim(retention, now);
    }

    /// Counts one hit against a rate-limit key and reports whether the window is over its
    /// rate. `period_ms` is the capture's window length; the window slides.
    pub fn hit_rate_limit(&self, key: &str, rate: u64, period_ms: u64) -> bool {
        let now = self.clock.now_ms();
        let mut limiter = self
            .runtime
            .limiter
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let window = limiter.entry(key.to_owned()).or_default();
        while let Some(front) = window.front() {
            if now.saturating_sub(*front) >= period_ms {
                window.pop_front();
            } else {
                break;
            }
        }
        window.push_back(now);
        window.len() as u64 > rate
    }

    /// Appends one admin audit entry and trims the file to its cap (D9).
    pub fn append_audit(
        &self,
        action: &str,
        remote_address: Option<&str>,
        detail: Option<Value>,
    ) -> Result<Value, AdminError> {
        let _guard = self
            .runtime
            .audit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let entry = serde_json::json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "at": iso8601(self.clock.now_ms()),
            "action": action,
        });
        let mut entry = entry;
        if let Value::Object(object) = &mut entry {
            if let Some(address) = remote_address {
                object.insert(
                    "remoteAddress".to_owned(),
                    Value::String(address.to_owned()),
                );
            }
            if let Some(detail) = detail {
                object.insert("detail".to_owned(), detail);
            }
        }

        let path = self.audit_log_path();
        let mut lines = read_audit_lines(&path)?;
        lines.push(entry.clone());
        if lines.len() > MAX_AUDIT_ENTRIES {
            let excess = lines.len() - MAX_AUDIT_ENTRIES;
            lines.drain(..excess);
        }
        write_audit_lines(&path, &lines)?;
        Ok(entry)
    }

    /// The clock's current time in whole seconds (`Math.floor(Date.now() / 1000)`).
    pub fn now_utc(&self) -> chrono::DateTime<chrono::Utc> {
        let now_ms = self.clock.now_ms();
        chrono::DateTime::<chrono::Utc>::from_timestamp(
            i64::try_from(now_ms / 1000).unwrap_or(i64::MAX),
            u32::try_from((now_ms % 1000) * 1_000_000).unwrap_or(0),
        )
        .unwrap_or_else(chrono::Utc::now)
    }

    /// Writes the user settings document, copying the previous file into the backups
    /// directory first (R8).
    pub fn save_user_settings(&self, document: &serde_yaml::Value) -> Result<(), AdminError> {
        nostream_config::store::save_with_backup(&self.paths, document, self.now_utc())?;
        Ok(())
    }

    /// Appends one line to `<config>/settings-audit.jsonl` (Value 38).
    pub fn append_settings_audit(&self, entry: serde_json::Value) -> Result<(), AdminError> {
        nostream_config::store::append_audit(&self.paths, &entry)?;
        Ok(())
    }

    /// Enqueues the `settings.changed` outbox row. A failure is logged, never fatal (R8).
    pub async fn enqueue_settings_changed(&self, payload: serde_json::Value) {
        match self
            .stores
            .notification_outbox
            .enqueue(SETTINGS_CHANGED, &payload)
            .await
        {
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(error = %error, "the settings.changed outbox row was not enqueued")
            }
        }
    }

    /// Enqueues any operator-notification row. A failure is logged, never fatal.
    pub async fn enqueue_notification(&self, event_type: &str, payload: serde_json::Value) {
        match self
            .stores
            .notification_outbox
            .enqueue(event_type, &payload)
            .await
        {
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(error = %error, event_type, "an outbox row was not enqueued")
            }
        }
    }

    /// The newest audit entries, newest first, clamped to `[1, 500]`.
    pub fn audit_entries(&self, limit: u64) -> Result<Vec<Value>, AdminError> {
        let clamped = limit.clamp(1, 500) as usize;
        let lines = read_audit_lines(&self.audit_log_path())?;
        Ok(lines.into_iter().rev().take(clamped).collect())
    }
}

/// The probe history's retention (`getNip66HistoryRetention`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProbeRetention {
    /// `nip66.historyRetentionRuns`; `None` keeps the default of 24.
    pub runs: Option<u64>,
    /// `nip66.historyRetentionHours`; `0` disables age trimming.
    pub hours: Option<u64>,
}

impl ProbeRetention {
    /// The default history size when the setting is absent (`DEFAULT_NIP66_HISTORY_RUNS`).
    pub const DEFAULT_RUNS: usize = 24;
    /// The cap a single history read may ask for (`MAX_PROBE_HISTORY_API_LIMIT`).
    pub const MAX_API_LIMIT: usize = 500;

    /// The effective run cap.
    pub fn run_cap(self) -> usize {
        match self.runs {
            Some(runs) if runs > 0 => usize::try_from(runs).unwrap_or(usize::MAX),
            _ => Self::DEFAULT_RUNS,
        }
    }
}

impl ProbeState {
    fn trim(&mut self, retention: ProbeRetention, now_ms: u64) {
        let cap = retention.run_cap();
        while self.runs.len() > cap {
            self.runs.pop_front();
        }
        if let Some(hours) = retention.hours
            && hours > 0
        {
            let cutoff = now_ms.saturating_sub(hours.saturating_mul(3_600_000));
            while let Some(front) = self.runs.front() {
                if front.at_ms < cutoff {
                    self.runs.pop_front();
                } else {
                    break;
                }
            }
        }
    }
}

fn read_audit_lines(path: &Path) -> Result<Vec<Value>, AdminError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(AdminError::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    Ok(raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect())
}

fn write_audit_lines(path: &Path, lines: &[Value]) -> Result<(), AdminError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|source| AdminError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let body: String = lines
        .iter()
        .map(|line| format!("{line}\n"))
        .collect::<Vec<String>>()
        .concat();
    std::fs::write(path, body).map_err(|source| AdminError::Io {
        path: path.to_path_buf(),
        source,
    })
}

/// `new Date().toISOString()` for a millisecond clock reading.
pub fn iso8601(now_ms: u64) -> String {
    let seconds = i64::try_from(now_ms / 1000).unwrap_or(i64::MAX);
    let millis = now_ms % 1000;
    chrono::DateTime::<chrono::Utc>::from_timestamp(
        seconds,
        u32::try_from(millis * 1_000_000).unwrap_or(0),
    )
    .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    .unwrap_or_default()
}

/// Logs a merged document's validation issues: an operator who saved a document the validator
/// disagrees with still gets the page, and the log says why.
pub fn log_validation(merged: &serde_yaml::Value, defaults: &serde_yaml::Value) {
    log_issues(&validate_merged(merged, defaults));
}

fn validate_merged(merged: &serde_yaml::Value, defaults: &serde_yaml::Value) -> Vec<Issue> {
    nostream_config::validate_document(merged, defaults)
}

fn log_issues(issues: &[Issue]) {
    for issue in issues {
        tracing::warn!(issue = %issue, "the settings document does not validate");
    }
}
