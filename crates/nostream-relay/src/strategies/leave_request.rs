//! The `leave-request` event strategy. Mirrors `src/handlers/event-strategies/leave-request-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::strategies::StrategyOutcome;

/// Phase 1 stub — job 005; will decide acceptance for kind-28935 leave requests; see `src/handlers/event-strategies/leave-request-event-strategy.ts`.
pub async fn handle(_event: &Event) -> Result<StrategyOutcome, RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::leave_request",
    })
}
