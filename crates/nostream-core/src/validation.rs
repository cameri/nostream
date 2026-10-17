//! Event validation against the base schema. Mirrors `src/utils/validation.ts` and
//! `src/utils/event.ts` (`validateEvent`).

use crate::error::CoreError;
use crate::event::Event;

/// Validates id/sig shape, kind bounds and tag structure before storage.
///
/// Phase 1 stub — job 005; will check the base schema before an event reaches storage;
/// see `src/utils/validation.ts`.
pub fn validate_event(_event: &Event) -> Result<(), CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::validation::validate_event",
    })
}
