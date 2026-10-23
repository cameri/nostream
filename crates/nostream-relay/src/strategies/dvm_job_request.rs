//! The `dvm-job-request` event strategy. Mirrors `src/handlers/event-strategies/dvm-job-request-event-strategy.ts`.

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;

/// Phase 2 stub — job 009; will store a job row for a NIP-90 request; see `src/handlers/event-strategies/dvm-job-request-event-strategy.ts`.
pub async fn execute(_event: &Event, _context: &HandlerContext) -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::dvm_job_request",
    })
}
