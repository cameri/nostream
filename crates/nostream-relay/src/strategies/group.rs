//! The `group` event strategy. Mirrors `src/handlers/event-strategies/group-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;

/// Phase 2 stub — job 009; will validate the h tag on a Marmot kind-445 group event; see `src/handlers/event-strategies/group-event-strategy.ts`.
pub async fn execute(_event: &Event, _context: &HandlerContext) -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::group",
    })
}
