//! The `group` event strategy. Mirrors `src/handlers/event-strategies/group-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `group` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct GroupStrategy;

impl EventStrategy for GroupStrategy {
    /// Phase 2 stub — job 009; will validate the h tag on a Marmot kind-445 group event; see `src/handlers/event-strategies/group-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::group",
            })
        })
    }
}
