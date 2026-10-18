//! NIP-65: relay list metadata. Mirrors `src/utils/nip65.ts`.

use crate::error::CoreError;
use crate::event::Event;

/// One relay entry of a kind-10002 event: the URL and whether it is a read or write relay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayListEntry {
    pub url: String,
    pub read: bool,
    pub write: bool,
}

/// Parses a kind-10002 event into its relay entries.
///
/// Phase 1 stub — job 005; will read the `r` tags and their markers; see `src/utils/nip65.ts`.
pub fn parse_relay_list(_event: &Event) -> Result<Vec<RelayListEntry>, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::nip65::parse_relay_list",
    })
}
