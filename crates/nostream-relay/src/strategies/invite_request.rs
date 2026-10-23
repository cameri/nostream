//! The `invite-request` event strategy. Mirrors `src/handlers/event-strategies/invite-request-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;

/// Phase 2 stub — job 009; will answer a published kind-28935 with "use a REQ instead"; see `src/handlers/event-strategies/invite-request-event-strategy.ts`.
pub async fn execute(_event: &Event, _context: &HandlerContext) -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::invite_request",
    })
}
