//! The health snapshot. Mirrors `src/utils/admin-health.ts`.
//!
//! `database` is the store answering a trivial read, within the ping deadline; `redis` is
//! always `{ok:false}` because the cache is gone (D2). `status` is `ok` only when both are.

use std::time::Duration;

use nostream_core::Pubkey;
use serde::Serialize;

use crate::state::AdminState;

/// `DEFAULT_ADMIN_DEPENDENCY_PING_TIMEOUT_MS` (`src/utils/admin-health.ts:8`).
pub const DEFAULT_PING_TIMEOUT_MS: u64 = 3_000;

/// The floor a configured ping timeout must reach (`MIN_ADMIN_DEPENDENCY_PING_TIMEOUT_MS`).
pub const MIN_PING_TIMEOUT_MS: u64 = 100;

/// One dependency's verdict (`AdminDependencyHealth`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DependencyHealth {
    pub ok: bool,
}

/// The health payload (`AdminHealthSnapshot`, `src/utils/admin-health.ts:17-25`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSnapshot {
    pub status: &'static str,
    pub uptime_seconds: u64,
    pub worker: WorkerIdentity,
    pub database: DependencyHealth,
    pub redis: DependencyHealth,
}

/// The worker a health snapshot is taken for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkerIdentity {
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<String>,
}

/// The capture's ping-timeout resolution: blank or unset is the default, a value under the
/// floor falls back with a warning.
pub fn resolve_ping_timeout(configured: Option<&str>) -> Duration {
    let Some(value) = configured.map(str::trim).filter(|value| !value.is_empty()) else {
        return Duration::from_millis(DEFAULT_PING_TIMEOUT_MS);
    };
    match value.parse::<u64>() {
        Ok(timeout) if timeout >= MIN_PING_TIMEOUT_MS => Duration::from_millis(timeout),
        _ => {
            tracing::warn!(
                value,
                "invalid admin dependency ping timeout, falling back to {DEFAULT_PING_TIMEOUT_MS}"
            );
            Duration::from_millis(DEFAULT_PING_TIMEOUT_MS)
        }
    }
}

/// Collects the snapshot: one trivial store read and the (absent) cache.
pub async fn collect(state: &AdminState) -> HealthSnapshot {
    let database = DependencyHealth {
        ok: ping_database(state).await,
    };
    // The cache is gone (D2), so `redis.ok` is false and the status can never be `ok`: the
    // capture's rule is `ok` only when both dependencies answer.
    let redis = DependencyHealth { ok: false };
    let (worker_type, worker_index) = state.worker_identity();

    HealthSnapshot {
        status: if database.ok && redis.ok {
            "ok"
        } else {
            "degraded"
        },
        uptime_seconds: state.uptime_seconds(),
        worker: WorkerIdentity {
            r#type: worker_type.to_owned(),
            index: worker_index.map(str::to_owned),
        },
        database,
        redis,
    }
}

async fn ping_database(state: &AdminState) -> bool {
    // The trivial read: a metadata lookup that returns without scanning the event store.
    // `redis.ok` is false by construction, so the status is `degraded` either way — the value
    // this reports is whether the store answers at all.
    let probe = Pubkey::from_byte_array([0u8; 32]);
    match tokio::time::timeout(
        Duration::from_millis(DEFAULT_PING_TIMEOUT_MS),
        state.stores().nip05.find_by_pubkey(&probe),
    )
    .await
    {
        Ok(result) => result.is_ok(),
        Err(_) => false,
    }
}
