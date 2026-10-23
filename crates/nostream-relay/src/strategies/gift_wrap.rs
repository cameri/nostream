//! The `gift-wrap` event strategy. Mirrors `src/handlers/event-strategies/gift-wrap-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;

/// Phase 2 stub — job 009; will validate the p tag and the NIP-44 payload before storing a kind-1059 gift wrap; see `src/handlers/event-strategies/gift-wrap-event-strategy.ts`.
pub async fn execute(_event: &Event, _context: &HandlerContext) -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::gift_wrap",
    })
}
