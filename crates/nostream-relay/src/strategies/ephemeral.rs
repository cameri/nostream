//! The `ephemeral` event strategy. Mirrors `src/handlers/event-strategies/ephemeral-event-strategy.ts`.
//!
//! Ephemeral kinds are relayed and never stored: `["OK",<id>,true,""]` and then a broadcast, with
//! no repository call at all.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `ephemeral` arm: kinds 20000..=29999 that no other arm claims.
#[derive(Debug, Clone, Copy, Default)]
pub struct EphemeralStrategy;

impl EventStrategy for EphemeralStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            context.send_ok(event.id, true, "", None);

            // A closed hub means no connection is listening; the event was still relayed.
            let _ = context.broadcast.send(Arc::new(event.clone()));

            Ok(())
        })
    }
}
