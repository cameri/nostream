//! The `parameterized-replaceable` event strategy. Mirrors
//! `src/handlers/event-strategies/parameterized-replaceable-event-strategy.ts`.
//!
//! Addressable kinds (30000..=39999) are replaced per `d` tag, so the first `d` tag's value
//! becomes the row's deduplication key — `[""]` when the event carries none, which is a key of
//! its own rather than the default `[pubkey, kind]`. Then the replaceable four steps: `upsert`,
//! `["OK",<id>,true,""]` or `"duplicate:"`, and a broadcast only when a row was written. A store
//! failure escapes to the handler; the capture has no catch in this arm either.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::{EventStrategy, event_record};

/// The `parameterized_replaceable` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct ParameterizedReplaceableStrategy;

impl EventStrategy for ParameterizedReplaceableStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            let deduplication = event
                .tags
                .iter()
                .find(|tag| tag.len() >= 2 && tag[0] == "d")
                .map(|tag| tag[1].clone())
                .unwrap_or_default();

            let record = event_record(event, context)
                .with_deduplication(vec![serde_json::Value::String(deduplication)]);
            let count = context.stores.events.upsert(&record).await?;

            context.send_ok(
                event.id,
                true,
                if count > 0 { "" } else { "duplicate:" },
                None,
            );

            if count > 0 {
                let _ = context.broadcast.send(Arc::new(event.clone()));
            }

            Ok(())
        })
    }
}
