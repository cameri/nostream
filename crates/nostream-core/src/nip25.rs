//! NIP-25: reactions. Mirrors `src/utils/nip25.ts`.

use crate::error::CoreError;
use crate::event::{Event, EventId, Kind};

/// Extracts the reacted-to event id from a kind-7 reaction.
///
/// Phase 1 stub — job 005; will read the last `e` tag of a kind-7 event; see `src/utils/nip25.ts`.
pub fn reacted_event_id(_event: &Event) -> Result<EventId, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::nip25::reacted_event_id",
    })
}

/// Whether a kind counts as a reaction for scoring purposes.
pub fn is_reaction(kind: Kind) -> bool {
    kind == Kind(7)
}
