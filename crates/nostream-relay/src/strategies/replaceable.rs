//! The `replaceable` event strategy. Mirrors `src/handlers/event-strategies/replaceable-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;

/// Phase 2 stub — job 009; will upsert a replaceable event by its precedence rule; see `src/handlers/event-strategies/replaceable-event-strategy.ts`.
pub async fn execute(_event: &Event, _context: &HandlerContext) -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::replaceable",
    })
}
