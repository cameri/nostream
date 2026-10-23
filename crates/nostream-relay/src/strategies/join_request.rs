//! The `join-request` event strategy. Mirrors `src/handlers/event-strategies/join-request-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;

/// Phase 2 stub — job 009; will claim an invite code and admit a member (NIP-43); see `src/handlers/event-strategies/join-request-event-strategy.ts`.
pub async fn execute(_event: &Event, _context: &HandlerContext) -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::join_request",
    })
}
