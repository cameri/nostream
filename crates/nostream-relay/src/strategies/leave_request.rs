//! The `leave-request` event strategy. Mirrors `src/handlers/event-strategies/leave-request-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `leave_request` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct LeaveRequestStrategy;

impl EventStrategy for LeaveRequestStrategy {
    /// Phase 2 stub — job 009; will revoke a member (NIP-43); see `src/handlers/event-strategies/leave-request-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::leave_request",
            })
        })
    }
}
