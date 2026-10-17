//! Backend resolution. Mirrors `src/utils/event-store.ts` `getConfiguredEventStoreBackend` /
//! `getEventStoreBackend`.

use std::env;

use crate::error::StorageError;

use nostream_config::Settings;

/// The environment variable the primary sets on every worker it forks
/// (`src/utils/event-store.ts` `EVENT_STORE_BACKEND_ENV`).
pub const EVENT_STORE_BACKEND_ENV: &str = "EVENT_STORE_BACKEND";

/// The backend the settings name, defaulting to postgres
/// (`src/utils/event-store.ts` `getConfiguredEventStoreBackend`).
pub fn configured_backend(settings: &Settings) -> nostream_core::EventStoreBackend {
    settings
        .event_store
        .as_ref()
        .map(|event_store| event_store.backend)
        .unwrap_or(nostream_core::EventStoreBackend::Postgres)
}

/// The backend a worker inherits from the primary, or the settings value
/// (`src/utils/event-store.ts` `getEventStoreBackend`).
///
/// `is_worker` stands in for `cluster.isWorker`; the daemon owns the distinction and passes it
/// in, so this module stays a pure function of (settings, env, is_worker).
pub fn resolved_backend(
    settings: &Settings,
    is_worker: bool,
) -> Result<nostream_core::EventStoreBackend, StorageError> {
    let inherited = if is_worker {
        env::var(EVENT_STORE_BACKEND_ENV).ok()
    } else {
        None
    };
    match inherited {
        None => Ok(configured_backend(settings)),
        Some(name) => nostream_core::EventStoreBackend::parse(&name).ok_or_else(|| {
            StorageError::UnsupportedBackend {
                value: name,
                env: EVENT_STORE_BACKEND_ENV,
            }
        }),
    }
}
