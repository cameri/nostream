//! The `count-message-handler.ts` handler.

use crate::error::RelayError;

/// Phase 1 stub — job 005; will handle a COUNT query; see `src/handlers/count-message-handler.ts`.
pub async fn handle() -> Result<u64, RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::handlers::count",
    })
}
