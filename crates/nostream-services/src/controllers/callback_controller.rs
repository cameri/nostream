//! `callbacks/index.ts`.

use crate::error::ServicesError;

/// Phase 2 stub — issue #867; will serve the processor callback routes; see `src/controllers/callbacks/index.ts`.
pub async fn handle() -> Result<(), ServicesError> {
    Err(ServicesError::NotImplemented {
        module: "services::controllers::callback_controller",
    })
}
