//! The `delete` event strategy. Mirrors `src/handlers/event-strategies/delete-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `delete` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct DeleteStrategy;

impl EventStrategy for DeleteStrategy {
    /// Phase 2 stub — job 009; will soft-delete the referenced events (NIP-09); see `src/handlers/event-strategies/delete-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::delete",
            })
        })
    }
}
