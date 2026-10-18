//! The `default` event strategy. Mirrors `src/handlers/event-strategies/default-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::strategies::StrategyOutcome;

/// Phase 1 stub — job 005; will decide acceptance for kinds with no dedicated strategy; see `src/handlers/event-strategies/default-event-strategy.ts`.
pub async fn handle(_event: &Event) -> Result<StrategyOutcome, RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::default",
    })
}
