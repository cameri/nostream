//! Event signing and hashing. Mirrors `src/utils/event.ts` (`verifyEvent`, `getEventHash`).
//!
//! Phase 1 carries no crypto dependency on purpose: `secp256k1` versus `k256` and schnorr
//! support is a Phase 2 security decision, recorded in the job's design notes.

use crate::error::CoreError;
use crate::event::{Event, EventId};

/// Verifies the Schnorr signature over the canonical serialization.
///
/// Phase 1 stub — job 005; will verify a Schnorr signature over the canonical event id; see `src/utils/event.ts`.
pub fn verify_event_signature(_event: &Event) -> Result<(), CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::crypto::verify_event_signature",
    })
}

/// Computes an event id (sha256 over `[0, pubkey, created_at, kind, tags, content]`).
///
/// Phase 1 stub — job 005; will hash the canonical serialization into an `EventId`; see `src/utils/event.ts`.
pub fn compute_event_id(_event: &Event) -> Result<EventId, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::crypto::compute_event_id",
    })
}
