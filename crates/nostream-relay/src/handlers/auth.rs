//! The `auth-message-handler.ts` handler.

use crate::error::RelayError;

/// Phase 1 stub — job 005; will handle a NIP-42 AUTH message; see `src/handlers/auth-message-handler.ts`.
pub async fn handle() -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::handlers::auth",
    })
}
