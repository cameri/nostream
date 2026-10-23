//! The `parameterized-replaceable` event strategy. Mirrors `src/handlers/event-strategies/parameterized-replaceable-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `parameterized_replaceable` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct ParameterizedReplaceableStrategy;

impl EventStrategy for ParameterizedReplaceableStrategy {
    /// Phase 2 stub — job 009; will upsert an addressable event by its d tag (NIP-33); see `src/handlers/event-strategies/parameterized-replaceable-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::parameterized_replaceable",
            })
        })
    }
}
