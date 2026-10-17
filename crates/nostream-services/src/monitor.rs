//! The NIP-66 probe family. Mirrors `src/utils/relay-probe/**`, `relay-probe-snapshot.ts`,
//! `relay-probe-targets.ts` and `monitor-identity.ts`.

use crate::error::ServicesError;

/// One probe target (`src/utils/relay-probe/target.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub relay_url: String,
    pub network: Option<String>,
}

/// The result of one probe run (`src/utils/relay-probe-snapshot.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Snapshot {
    pub reachable: bool,
    pub rtt_ms: Option<u64>,
}

/// Phase 1 stub — job 005; will resolve a DNS record with the cache TTL; see `src/utils/relay-probe/dns-probe.ts`.
pub async fn dns_probe(_target: &Target) -> Result<Snapshot, ServicesError> {
    Err(ServicesError::NotImplemented {
        module: "services::monitor::DnsProbe::execute",
    })
}

/// Phase 1 stub — job 005; will open TLS and record the handshake time; see `src/utils/relay-probe/tls-probe.ts`.
pub async fn tls_probe(_target: &Target) -> Result<Snapshot, ServicesError> {
    Err(ServicesError::NotImplemented {
        module: "services::monitor::TlsProbe::execute",
    })
}

/// Phase 1 stub — job 005; will fetch the NIP-11 document; see `src/utils/relay-probe/nip11-probe.ts`.
pub async fn nip11_probe(_target: &Target) -> Result<Snapshot, ServicesError> {
    Err(ServicesError::NotImplemented {
        module: "services::monitor::Nip11Probe::execute",
    })
}

/// Phase 1 stub — job 005; will speak the WebSocket protocol and read the RTT; see `src/utils/relay-probe/ws-rtt-probe.ts`.
pub async fn ws_rtt_probe(_target: &Target) -> Result<Snapshot, ServicesError> {
    Err(ServicesError::NotImplemented {
        module: "services::monitor::WsRttProbe::execute",
    })
}

/// Phase 1 stub — job 005; will run every probe for one target and merge the snapshot; see `src/utils/relay-probe/run-probe.ts`.
pub async fn run_probe(_target: &Target) -> Result<Snapshot, ServicesError> {
    Err(ServicesError::NotImplemented {
        module: "services::monitor::RunProbe::execute",
    })
}
