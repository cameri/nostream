//! The `delete` event strategy. Mirrors `src/handlers/event-strategies/delete-event-strategy.ts`.
//!
//! A NIP-09 request: every `e` tag whose value is 64 lowercase hex characters is soft-deleted
//! **before** the request itself is stored, so a client that re-reads after the `OK` sees the
//! deletions already applied. Then the common create-or-dedupe.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::{EventStrategy, event_record, is_lowercase_hex64};

/// The `delete` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct DeleteStrategy;

impl EventStrategy for DeleteStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            let ids: Vec<nostream_core::EventId> = event
                .tags
                .iter()
                .filter(|tag| tag.len() >= 2 && tag[0] == "e" && is_lowercase_hex64(&tag[1]))
                .filter_map(|tag| tag[1].parse().ok())
                .collect();

            if !ids.is_empty() {
                context
                    .stores
                    .events
                    .delete_by_pubkey_and_ids(&event.pubkey, &ids)
                    .await?;
            }

            let record = event_record(event, context);
            let count = context.stores.events.create(&record).await?;

            context.send_ok(event.id, true, if count > 0 { "" } else { "duplicate:" }, None);

            if count > 0 {
                let _ = context.broadcast.send(Arc::new(event.clone()));
            }

            Ok(())
        })
    }
}
