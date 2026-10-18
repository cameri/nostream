//! The background workers. Mirrors `src/services/**` scheduling and the `src/workers/*`
//! families (the capture's worker loop lives in `src/utils/scheduler.ts` and the per-worker
//! files under `src/workers/`).

use crate::error::DaemonError;

/// Phase 1 stub — job 005; will schedule the recurring workers; see `src/utils/scheduler.ts`.
pub async fn spawn_workers() -> Result<(), DaemonError> {
    Err(DaemonError::NotImplemented {
        module: "nostreamd::workers::spawn_workers",
    })
}

/// Phase 1 stub — job 005; will bootstrap the tor hidden service; see `src/tor/index.ts`.
pub async fn spawn_tor() -> Result<(), DaemonError> {
    Err(DaemonError::NotImplemented {
        module: "nostreamd::workers::spawn_tor",
    })
}
