//! The `subscribe-message-handler.ts` handler.

use crate::error::RelayError;

/// Phase 1 stub — job 005; will handle a REQ message; see `src/handlers/subscribe-message-handler.ts`.
pub async fn handle() -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::handlers::subscribe",
    })
}
