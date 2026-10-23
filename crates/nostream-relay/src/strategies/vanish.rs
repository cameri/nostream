//! The `vanish` event strategy. Mirrors `src/handlers/event-strategies/vanish-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `vanish` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct VanishStrategy;

impl EventStrategy for VanishStrategy {
    /// Phase 2 stub — job 009; will delete the requester's events and mark the pubkey vanished (NIP-62); see `src/handlers/event-strategies/vanish-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::vanish",
            })
        })
    }
}
