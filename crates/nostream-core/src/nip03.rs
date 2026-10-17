//! NIP-03: OpenTimestamps attestations. Mirrors `src/utils/nip03.ts`.

use crate::error::CoreError;
use crate::event::Event;

/// Extracts the OpenTimestamps attestation attached to an event.
///
/// Phase 1 stub — job 005; will decode the `ots` tag and verify its digest; see `src/utils/nip03.ts`.
pub fn parse_attestation(_event: &Event) -> Result<Vec<u8>, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::nip03::parse_attestation",
    })
}
