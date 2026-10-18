//! The `replaceable` event strategy. Mirrors `src/handlers/event-strategies/replaceable-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::strategies::StrategyOutcome;

/// Phase 1 stub — job 005; will decide acceptance for kinds 0, 3 and 10000-19999; see `src/handlers/event-strategies/replaceable-event-strategy.ts`.
pub async fn handle(_event: &Event) -> Result<StrategyOutcome, RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::replaceable",
    })
}
