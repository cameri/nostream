//! The `invite-request` event strategy. Mirrors `src/handlers/event-strategies/invite-request-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::strategies::StrategyOutcome;

/// Phase 1 stub — job 005; will decide acceptance for NIP-43 invite requests; see `src/handlers/event-strategies/invite-request-event-strategy.ts`.
pub async fn handle(_event: &Event) -> Result<StrategyOutcome, RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::invite_request",
    })
}
