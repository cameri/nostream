//! The `leave-request` event strategy. Mirrors `src/handlers/event-strategies/leave-request-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;

/// Phase 2 stub — job 009; will revoke a member (NIP-43); see `src/handlers/event-strategies/leave-request-event-strategy.ts`.
pub async fn execute(_event: &Event, _context: &HandlerContext) -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::leave_request",
    })
}
