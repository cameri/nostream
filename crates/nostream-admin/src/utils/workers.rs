//! The worker rows `GET /ops/workers` reports. Mirrors `src/utils/admin-ops-config.ts`.

use std::time::{SystemTime, UNIX_EPOCH};

use nostream_config::Settings;
use serde::Serialize;

use crate::state::{AdminState, HEARTBEAT_TTL_SECONDS, WorkerHeartbeat, heartbeat_key};

/// The worker types the capture never marks monitored (`UNMONITORED_WORKER_TYPES`).
const UNMONITORED_WORKER_TYPES: [&str; 2] = ["worker", "dvm-orchestrator"];

/// One configured worker (`AdminOpsConfiguredWorker`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredWorker {
    #[serde(rename = "type")]
    pub worker_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<String>,
    pub enabled: bool,
    pub label: String,
}

/// One row of `GET /ops/workers` (`AdminOpsWorkerRow`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRow {
    #[serde(rename = "type")]
    pub worker_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<String>,
    pub enabled: bool,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heartbeat: Option<WorkerHeartbeat>,
    pub monitored: bool,
    pub stale: bool,
}

/// Whether a configured type is judged by its heartbeat (`isAdminOpsWorkerMonitored`).
pub fn is_monitored(worker_type: &str) -> bool {
    !UNMONITORED_WORKER_TYPES.contains(&worker_type)
}

/// `listConfiguredWorkers`: `WORKER_COUNT` → `workers.count` → the CPU count, then one row per
/// client worker, `maintenance`, `relay-monitor` when NIP-66 is on, and one per DVM worker.
pub fn list_configured_workers(
    settings: &Settings,
    worker_count_override: Option<u32>,
    cpu_count: u32,
) -> Vec<ConfiguredWorker> {
    let configured_count = settings.workers.as_ref().map(|workers| workers.count);
    let worker_count = worker_count_override
        .or(configured_count)
        .unwrap_or(cpu_count);

    let mut workers = Vec::new();
    for index in 0..worker_count {
        workers.push(ConfiguredWorker {
            worker_type: "worker".to_owned(),
            index: Some(index.to_string()),
            enabled: true,
            label: format!("Client worker {index}"),
        });
    }

    workers.push(ConfiguredWorker {
        worker_type: "maintenance".to_owned(),
        index: None,
        enabled: true,
        label: "Maintenance".to_owned(),
    });

    if settings.nip66.as_ref().is_some_and(|nip66| nip66.enabled) {
        workers.push(ConfiguredWorker {
            worker_type: "relay-monitor".to_owned(),
            index: None,
            enabled: true,
            label: "Relay monitor (NIP-66)".to_owned(),
        });
    }

    let dvm_workers = settings
        .dvm
        .as_ref()
        .and_then(|dvm| dvm.workers.as_ref())
        .map(Vec::len)
        .unwrap_or(0);
    for index in 0..dvm_workers {
        workers.push(ConfiguredWorker {
            worker_type: "dvm-orchestrator".to_owned(),
            index: Some(index.to_string()),
            enabled: true,
            label: format!("DVM orchestrator {index}"),
        });
    }

    workers
}

/// `isAdminOpsHeartbeatStale`: a heartbeat older than the TTL, or an unparsable one.
pub fn is_heartbeat_stale(updated_at: &str, now_ms: u64, ttl_seconds: u64) -> bool {
    let Ok(updated) = chrono::DateTime::parse_from_rfc3339(updated_at) else {
        return true;
    };
    let updated_ms = updated.timestamp_millis();
    let now = i64::try_from(now_ms).unwrap_or(i64::MAX);
    now.saturating_sub(updated_ms)
        > i64::try_from(ttl_seconds.saturating_mul(1000)).unwrap_or(i64::MAX)
}

/// `mergeWorkerRows`: pairs each configured row with its heartbeat by `type:index`.
pub fn merge_worker_rows(
    configured: Vec<ConfiguredWorker>,
    heartbeats: Vec<WorkerHeartbeat>,
    now_ms: u64,
) -> Vec<WorkerRow> {
    let mut by_key: std::collections::HashMap<String, WorkerHeartbeat> = heartbeats
        .into_iter()
        .map(|heartbeat| (heartbeat.key(), heartbeat))
        .collect();

    configured
        .into_iter()
        .map(|worker| {
            let key = heartbeat_key(&worker.worker_type, worker.index.as_deref());
            let heartbeat = by_key.remove(&key);
            let monitored = is_monitored(&worker.worker_type);
            let stale = monitored
                && heartbeat.as_ref().is_none_or(|heartbeat| {
                    is_heartbeat_stale(&heartbeat.updated_at, now_ms, HEARTBEAT_TTL_SECONDS)
                });
            WorkerRow {
                worker_type: worker.worker_type,
                index: worker.index,
                enabled: worker.enabled,
                label: worker.label,
                heartbeat,
                monitored,
                stale,
            }
        })
        .collect()
}

/// The configured rows merged with the heartbeats the process has published.
pub fn rows(state: &AdminState, settings: &Settings) -> Vec<WorkerRow> {
    let cpu_count = std::thread::available_parallelism()
        .map(|count| u32::try_from(count.get()).unwrap_or(1))
        .unwrap_or(1);
    let configured = list_configured_workers(settings, state.worker_count_override(), cpu_count);
    merge_worker_rows(configured, state.heartbeats(), state.clock().now_ms())
}

/// The daemon's process start, for a caller that wants a monotonic reading.
pub fn system_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::state::WorkerHeartbeat;

    fn settings() -> Settings {
        let raw = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../resources/default-settings.yaml"),
        )
        .unwrap();
        serde_yaml::from_str(&raw).unwrap()
    }

    #[test]
    fn the_configured_rows_are_the_captures() {
        let mut settings = settings();
        settings.workers = Some(nostream_config::settings::Worker { count: 2 });
        let configured = list_configured_workers(&settings, None, 8);
        assert_eq!(configured.len(), 3);
        assert_eq!(configured[0].label, "Client worker 0");
        assert_eq!(configured[1].index.as_deref(), Some("1"));
        assert_eq!(configured[2].worker_type, "maintenance");
        assert!(!is_monitored("worker"));
        assert!(!is_monitored("dvm-orchestrator"));
        assert!(is_monitored("maintenance"));
    }

    #[test]
    fn a_published_heartbeat_is_fresh_and_a_missing_one_is_stale() {
        let configured = vec![
            ConfiguredWorker {
                worker_type: "maintenance".to_owned(),
                index: None,
                enabled: true,
                label: "Maintenance".to_owned(),
            },
            ConfiguredWorker {
                worker_type: "relay-monitor".to_owned(),
                index: None,
                enabled: true,
                label: "Relay monitor".to_owned(),
            },
            ConfiguredWorker {
                worker_type: "worker".to_owned(),
                index: Some("0".to_owned()),
                enabled: true,
                label: "Client worker 0".to_owned(),
            },
        ];
        let now = 1_700_000_000_000u64;
        let heartbeats = vec![WorkerHeartbeat {
            r#type: "maintenance".to_owned(),
            index: None,
            last_run_started_at: None,
            last_run_finished_at: None,
            last_error: None,
            updated_at: crate::state::iso8601(now - 1_000),
        }];
        let rows = merge_worker_rows(configured, heartbeats, now);
        assert!(
            !rows[0].stale,
            "the published maintenance heartbeat is fresh"
        );
        assert!(rows[1].stale, "an unpublished monitored row is stale");
        assert!(!rows[2].monitored, "a client worker is unmonitored");
        assert!(!rows[2].stale, "an unmonitored row is never stale");
    }
}
