//! The `timestamp` event strategy. Mirrors `src/handlers/event-strategies/timestamp-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `timestamp` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct TimestampStrategy;

impl EventStrategy for TimestampStrategy {
    /// Phase 2 stub — job 009; will validate the OpenTimestamps attestation (NIP-03); see `src/handlers/event-strategies/timestamp-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::timestamp",
            })
        })
    }
}
