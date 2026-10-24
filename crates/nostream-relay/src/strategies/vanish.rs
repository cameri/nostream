//! The `vanish` event strategy. Mirrors `src/handlers/event-strategies/vanish-event-strategy.ts`.
//!
//! A NIP-62 request to vanish: soft-delete every live event of the requester's except other
//! kind-62 requests, store the request itself, then mark the pubkey vanished.
//!
//! Two things are load-bearing here. There is **no broadcast** — the request is answered to its
//! author alone — and there is **no catch**: a storage failure escapes to the handler, which
//! answers `error: unable to process event` rather than a policy refusal.

use std::future::Future;
use std::pin::Pin;

use nostream_core::{Event, Kind};

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::{EventStrategy, event_record};

/// The `vanish` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct VanishStrategy;

impl EventStrategy for VanishStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            context
                .stores
                .events
                .delete_by_pubkey_except_kinds(&event.pubkey, &[Kind::REQUEST_TO_VANISH])
                .await?;

            let record = event_record(event, context);
            let count = context.stores.events.create(&record).await?;

            context
                .stores
                .users
                .set_vanished(&event.pubkey, true)
                .await?;

            context.send_ok(
                event.id,
                true,
                if count > 0 { "" } else { "duplicate:" },
                None,
            );

            Ok(())
        })
    }
}
