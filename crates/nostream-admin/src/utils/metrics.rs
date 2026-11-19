//! The `/metrics` SSE snapshot. Mirrors the `unavailable` half of `src/utils/admin-metrics.ts`.
//!
//! shortcut: the snapshot is the capture's unavailable shape with real health, upgrade when the
//! relay grows accepted/rejected counters or a Prometheus endpoint (ADR 0014, D5).
//!
//! The capture assembles its snapshot from Prometheus queries; the Rust process has neither a
//! Prometheus endpoint nor accepted/rejected counters (D5), so what it emits is the shape the
//! capture itself emits when collection fails — `status: "unavailable"`, the seven numeric keys
//! at zero, the real health objects and `prometheus.available: false` — which the console's
//! `updateSnapshot` renders (`dashboard.js:1597-1634` accepts any parsable object).

use std::time::Duration;

use serde_json::{Value, json};

use crate::utils::health::HealthSnapshot;

/// `DEFAULT_ADMIN_METRICS_SSE_INTERVAL_MS` (`src/utils/admin-metrics.ts:163-171`).
pub const DEFAULT_INTERVAL_MS: u64 = 5_000;

/// The floor a configured interval must reach; anything under it falls back.
pub const MIN_INTERVAL_MS: u64 = 1_000;

/// The prometheus error the snapshot carries: the capture's own message for a query that
/// returned nothing, which is the honest one here because no query is issued.
pub const PROMETHEUS_ERROR: &str = "Prometheus query returned no data";

/// `getAdminMetricsSseIntervalMs`: a value under the floor, or a non-number, is 5,000 ms.
pub fn resolve_interval(configured: Option<&str>) -> Duration {
    let Some(value) = configured.map(str::trim).filter(|value| !value.is_empty()) else {
        return Duration::from_millis(DEFAULT_INTERVAL_MS);
    };
    match value.parse::<u64>() {
        Ok(interval) if interval >= MIN_INTERVAL_MS => Duration::from_millis(interval),
        _ => Duration::from_millis(DEFAULT_INTERVAL_MS),
    }
}

/// The seven numeric keys the console reads, all zero without a source for them.
fn empty_metrics() -> Value {
    json!({
        "eventsPerSecond": 0,
        "eventsRejectedPerSecond": 0,
        "eventsAcceptedTotal": 0,
        "eventsRejectedTotal": 0,
        "activeConnections": 0,
        "cpuLoadPercent": 0,
        "memoryUsedMb": 0,
    })
}

/// The snapshot one SSE frame carries (`createUnavailableAdminMetricsSnapshot`).
pub fn unavailable_snapshot(now_ms: u64, health: &HealthSnapshot) -> Value {
    json!({
        "timestamp": now_ms,
        "status": "unavailable",
        "metrics": empty_metrics(),
        "health": {
            "database": health.database,
            "redis": health.redis,
        },
        "prometheus": {
            "available": false,
            "error": PROMETHEUS_ERROR,
        },
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::utils::health::{DependencyHealth, WorkerIdentity};

    #[test]
    fn an_interval_under_the_floor_falls_back() {
        assert_eq!(resolve_interval(Some("999")), Duration::from_millis(5_000));
        assert_eq!(resolve_interval(Some("1000")), Duration::from_millis(1_000));
        assert_eq!(resolve_interval(Some("2500")), Duration::from_millis(2_500));
        assert_eq!(resolve_interval(Some("soon")), Duration::from_millis(5_000));
        assert_eq!(resolve_interval(None), Duration::from_millis(5_000));
        assert_eq!(resolve_interval(Some(" ")), Duration::from_millis(5_000));
    }

    #[test]
    fn the_snapshot_carries_the_seven_keys_and_the_real_health() {
        let health = HealthSnapshot {
            status: "degraded",
            uptime_seconds: 3,
            worker: WorkerIdentity {
                r#type: "primary".to_owned(),
                index: None,
            },
            database: DependencyHealth { ok: true },
            redis: DependencyHealth { ok: false },
        };
        let snapshot = unavailable_snapshot(1_700_000_000_000, &health);
        assert_eq!(snapshot["timestamp"], json!(1_700_000_000_000u64));
        assert_eq!(snapshot["status"], json!("unavailable"));
        for key in [
            "eventsPerSecond",
            "eventsRejectedPerSecond",
            "eventsAcceptedTotal",
            "eventsRejectedTotal",
            "activeConnections",
            "cpuLoadPercent",
            "memoryUsedMb",
        ] {
            assert!(snapshot["metrics"][key].is_number(), "{key} is numeric");
        }
        assert_eq!(snapshot["metrics"].as_object().unwrap().len(), 7);
        assert_eq!(snapshot["health"]["database"]["ok"], json!(true));
        assert_eq!(snapshot["health"]["redis"]["ok"], json!(false));
        assert_eq!(snapshot["prometheus"]["available"], json!(false));
        assert!(snapshot["prometheus"]["error"].is_string());
    }
}
