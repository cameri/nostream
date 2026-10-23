//! The `default` event strategy. Mirrors `src/handlers/event-strategies/default-event-strategy.ts`.
//!
//! `EventRepository::create`, then `["OK",<id>,true,""]` when a row was inserted or
//! `["OK",<id>,true,"duplicate:"]` when it was not, then a broadcast **only** on insert.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The default arm: kinds with no dedicated strategy.
#[derive(Debug, Clone, Copy, Default)]
pub struct DefaultStrategy;

impl EventStrategy for DefaultStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            let record = nostream_storage::repositories::EventRecord {
                row_id: None,
                event: event.clone(),
                first_seen: None,
                deleted_at: None,
                expires_at: nostream_core::expiration::get_event_expiration(event).map(i64::from),
                event_deduplication: None,
                remote_address: context.connection.remote_address.parse().ok(),
            };

            let count = context.stores.events.create(&record).await?;

            let message = if count > 0 { "" } else { "duplicate:" };

            context.send_ok(event.id, true, message, None);

            if count > 0 {
                // A closed hub means no connection is listening; the event is still stored.
                // The hub carries a shared event, so every connection's fan-out is one
                // reference count rather than a copy of the payload.
                let _ = context.broadcast.send(std::sync::Arc::new(event.clone()));
            }

            Ok(())
        })
    }
}
