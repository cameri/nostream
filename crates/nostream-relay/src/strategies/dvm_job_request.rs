//! The `dvm-job-request` event strategy. Mirrors `src/handlers/event-strategies/dvm-job-request-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `dvm_job_request` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct DvmJobRequestStrategy;

impl EventStrategy for DvmJobRequestStrategy {
    /// Phase 2 stub — job 009; will store a job row for a NIP-90 request; see `src/handlers/event-strategies/dvm-job-request-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::dvm_job_request",
            })
        })
    }
}
