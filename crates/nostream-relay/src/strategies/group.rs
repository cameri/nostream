//! The `group` event strategy. Mirrors `src/handlers/event-strategies/group-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::strategies::StrategyOutcome;

/// Phase 1 stub — job 005; will decide acceptance for Marmot group events; see `src/handlers/event-strategies/group-event-strategy.ts`.
pub async fn handle(_event: &Event) -> Result<StrategyOutcome, RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::group",
    })
}
