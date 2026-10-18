//! Proof-of-work. Mirrors `src/utils/proof-of-work.ts` and `src/utils/adaptive-pow.ts`.

use crate::error::CoreError;
use crate::event::Event;

/// Whether the event id carries at least `difficulty` leading zero bits.
///
/// Phase 1 stub — job 005; will count leading zero bits on the event id; see `src/utils/proof-of-work.ts`.
pub fn check(_event: &Event, _difficulty: u32) -> Result<bool, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::pow::check",
    })
}
