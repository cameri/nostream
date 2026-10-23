//! The `contact-list` event strategy. Mirrors `src/handlers/event-strategies/contact-list-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;

/// Phase 2 stub — job 009; will upsert a kind-3 contact list and refresh the WoT graph (NIP-02); see `src/handlers/event-strategies/contact-list-event-strategy.ts`.
pub async fn execute(_event: &Event, _context: &HandlerContext) -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::contact_list",
    })
}
