//! The `gift-wrap` event strategy. Mirrors `src/handlers/event-strategies/gift-wrap-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `gift_wrap` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct GiftWrapStrategy;

impl EventStrategy for GiftWrapStrategy {
    /// Phase 2 stub — job 009; will validate the p tag and the NIP-44 payload before storing a kind-1059 gift wrap; see `src/handlers/event-strategies/gift-wrap-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::gift_wrap",
            })
        })
    }
}
