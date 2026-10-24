//! The `ephemeral` event strategy. Mirrors `src/handlers/event-strategies/ephemeral-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `ephemeral` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct EphemeralStrategy;

impl EventStrategy for EphemeralStrategy {
    /// Phase 2 stub — job 009; will answer OK and broadcast without storing; see `src/handlers/event-strategies/ephemeral-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::ephemeral",
            })
        })
    }
}
