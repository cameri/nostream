//! The `invite-request` event strategy. Mirrors `src/handlers/event-strategies/invite-request-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `invite_request` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct InviteRequestStrategy;

impl EventStrategy for InviteRequestStrategy {
    /// Phase 2 stub — job 009; will answer a published kind-28935 with "use a REQ instead"; see `src/handlers/event-strategies/invite-request-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::invite_request",
            })
        })
    }
}
