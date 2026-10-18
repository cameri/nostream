//! The `ephemeral` event strategy. Mirrors `src/handlers/event-strategies/ephemeral-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::strategies::StrategyOutcome;

/// Phase 1 stub — job 005; will decide acceptance for kinds 20000-29999; see `src/handlers/event-strategies/ephemeral-event-strategy.ts`.
pub async fn handle(_event: &Event) -> Result<StrategyOutcome, RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::ephemeral",
    })
}
