//! NIP-66: relay liveness and metadata events. Mirrors `src/utils/nip66-events.ts`,
//! `src/utils/nip66-nip11-tags.ts` and `src/utils/nip66-schedule.ts`.

use crate::error::CoreError;
use crate::event::{Event, Kind};

/// A parsed kind-30166 relay discovery event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayDiscovery {
    pub relay_url: String,
    pub network: Option<String>,
    pub rtt_open: Option<u64>,
    pub supported_nips: Vec<u16>,
}

/// Parses a kind-30166 event into its tags.
///
/// Phase 1 stub — job 005; will read `d`/`n`/`rtt-open`/`N` tags; see `src/utils/nip66-events.ts`.
pub fn parse_discovery(_event: &Event) -> Result<RelayDiscovery, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::nip66::parse_discovery",
    })
}

/// Whether a kind belongs to the NIP-66 monitor family.
pub fn is_monitor_kind(kind: Kind) -> bool {
    matches!(kind.0, 10_166 | 30_166 | 50_166)
}
