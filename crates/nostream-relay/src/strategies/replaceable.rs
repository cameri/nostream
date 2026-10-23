//! The `replaceable` event strategy. Mirrors `src/handlers/event-strategies/replaceable-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `replaceable` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReplaceableStrategy;

impl EventStrategy for ReplaceableStrategy {
    /// Phase 2 stub — job 009; will upsert a replaceable event by its precedence rule; see `src/handlers/event-strategies/replaceable-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::replaceable",
            })
        })
    }
}
