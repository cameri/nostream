//! The `gift-wrap` event strategy. Mirrors `src/handlers/event-strategies/gift-wrap-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::strategies::StrategyOutcome;

/// Phase 1 stub — job 005; will decide acceptance for NIP-59 gift wraps; see `src/handlers/event-strategies/gift-wrap-event-strategy.ts`.
pub async fn handle(_event: &Event) -> Result<StrategyOutcome, RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::gift_wrap",
    })
}
