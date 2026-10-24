//! The `contact-list` event strategy. Mirrors
//! `src/handlers/event-strategies/contact-list-event-strategy.ts`.
//!
//! Kind 3 is both replaceable and a contact list, so the selector intercepts it before the
//! replaceable arm and this one adds the NIP-02 side effect: after a `p`-tag refresh of the
//! author's follows in the trust graph, best-effort. The list is stored and broadcast before the
//! graph is touched, so a graph failure never rejects a valid event.
//!
//! A failed upsert is `rejected: event already exists` when the event id already exists and the
//! handler's generic failure otherwise — the store's own text is never forwarded (ADR 0006).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use nostream_core::Event;
use nostream_storage::StorageError;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::{EventStrategy, event_record};

/// The `contact_list` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct ContactListStrategy;

impl EventStrategy for ContactListStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            let record = event_record(event, context);

            let count = match context.stores.events.upsert(&record).await {
                Ok(count) => count,
                Err(StorageError::DuplicateEvent) => {
                    context.send_ok(event.id, false, "rejected: event already exists", None);

                    return Ok(());
                }
                Err(error) => return Err(error.into()),
            };

            context.send_ok(
                event.id,
                true,
                if count > 0 { "" } else { "duplicate:" },
                None,
            );

            if count == 0 {
                return Ok(());
            }

            let _ = context.broadcast.send(Arc::new(event.clone()));

            // A `p` tag with no value names no follow; the capture forwards `undefined` and
            // leaves it to the graph service to reject, and this skips it instead.
            let follows: Vec<String> = event
                .tags
                .iter()
                .filter(|tag| tag[0] == "p")
                .filter_map(|tag| tag.get(1).cloned())
                .collect();

            if let Err(error) = context
                .wot
                .update_follow_list(&event.pubkey, &follows)
                .await
            {
                tracing::error!(
                    error = %error,
                    pubkey = %event.pubkey,
                    "unable to update wot graph"
                );
            }

            Ok(())
        })
    }
}
