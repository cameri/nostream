//! The `join-request` event strategy. Mirrors `src/handlers/event-strategies/join-request-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `join_request` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct JoinRequestStrategy;

impl EventStrategy for JoinRequestStrategy {
    /// Phase 2 stub — job 009; will claim an invite code and admit a member (NIP-43); see `src/handlers/event-strategies/join-request-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::join_request",
            })
        })
    }
}
