//! What the daemon hands every worker: the settings and the collaborators a service needs.

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::broadcast;

use nostream_config::Settings;
use nostream_core::Event;
use nostream_core::clock::Clock;
use nostream_core::nip05::Nip05Fetch;
use nostream_core::random::RandomSource;
use nostream_relay::relay_key::RelayKeySource;

use crate::http::HttpClient;
use crate::unavailable::ServiceStores;

/// One process's service context, built once by `nostreamd::serve`.
#[derive(Clone)]
pub struct ServiceContext {
    pub settings: Arc<Settings>,
    pub clock: Arc<dyn Clock>,
    pub random: Arc<dyn RandomSource>,
    pub keys: Arc<RelayKeySource>,
    pub stores: Arc<ServiceStores>,
    /// The relay's process-wide event fan-out; a service-published event reaches live
    /// subscriptions exactly as a handler's own broadcast does.
    pub hub: broadcast::Sender<Arc<Event>>,
    pub http: Arc<dyn HttpClient>,
    /// The same transport as `http`, narrowed to the NIP-05 fetch seam core owns.
    pub fetch: Arc<dyn Nip05Fetch>,
    /// The configuration directory, which is where Tor's key file lives (`R37`).
    pub config_dir: PathBuf,
}

impl std::fmt::Debug for ServiceContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ServiceContext")
            .field("relay_url", &self.settings.info.relay_url)
            .field("config_dir", &self.config_dir)
            .finish_non_exhaustive()
    }
}
