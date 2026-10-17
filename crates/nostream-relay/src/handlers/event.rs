//! The `event-message-handler.ts` handler.

use crate::error::RelayError;

/// Phase 1 stub — job 005; will handle an EVENT message; see `src/handlers/event-message-handler.ts`.
pub async fn handle() -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::handlers::event",
    })
}
