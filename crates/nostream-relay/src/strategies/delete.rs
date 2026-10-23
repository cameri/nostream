//! The `delete` event strategy. Mirrors `src/handlers/event-strategies/delete-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;

/// Phase 2 stub — job 009; will soft-delete the referenced events (NIP-09); see `src/handlers/event-strategies/delete-event-strategy.ts`.
pub async fn execute(_event: &Event, _context: &HandlerContext) -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::delete",
    })
}
