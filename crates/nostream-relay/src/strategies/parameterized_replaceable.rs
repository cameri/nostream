//! The `parameterized-replaceable` event strategy. Mirrors `src/handlers/event-strategies/parameterized-replaceable-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;

/// Phase 2 stub — job 009; will upsert an addressable event by its d tag (NIP-33); see `src/handlers/event-strategies/parameterized-replaceable-event-strategy.ts`.
pub async fn execute(_event: &Event, _context: &HandlerContext) -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::parameterized_replaceable",
    })
}
