//! The `replaceable` event strategy. Mirrors
//! `src/handlers/event-strategies/replaceable-event-strategy.ts`.
//!
//! `EventRepository::upsert` applies the precedence rule in storage — the incoming row wins when
//! it is newer, or equal and the smaller id — so this arm only reads the answer: `["OK",<id>,true,""]`
//! when a row was written, `"duplicate:"` when the stored row won, and a broadcast only for the
//! first. A failed upsert is `rejected: event already exists` when the event id already exists
//! and the handler's generic failure otherwise: the store's own text is never forwarded to a
//! client (ADR 0006).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use nostream_core::Event;
use nostream_storage::StorageError;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::{EventStrategy, event_record};

/// The `replaceable` arm: kinds 0, 3, 41 and 10000..=19999.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReplaceableStrategy;

impl EventStrategy for ReplaceableStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            let record = event_record(event, context);

            match context.stores.events.upsert(&record).await {
                Ok(count) => {
                    context.send_ok(
                        event.id,
                        true,
                        if count > 0 { "" } else { "duplicate:" },
                        None,
                    );

                    if count > 0 {
                        let _ = context.broadcast.send(Arc::new(event.clone()));
                    }
                }
                Err(StorageError::DuplicateEvent) => {
                    context.send_ok(event.id, false, "rejected: event already exists", None);
                }
                Err(error) => return Err(error.into()),
            }

            Ok(())
        })
    }
}
