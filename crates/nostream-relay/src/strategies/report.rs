//! The `report` event strategy. Mirrors `src/handlers/event-strategies/report-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `report` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReportStrategy;

impl EventStrategy for ReportStrategy {
    /// Phase 2 stub — job 009; will score and store a kind-1984 report (NIP-56); see `src/handlers/event-strategies/report-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::report",
            })
        })
    }
}
