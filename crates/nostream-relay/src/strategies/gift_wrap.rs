//! The `gift-wrap` event strategy. Mirrors
//! `src/handlers/event-strategies/gift-wrap-event-strategy.ts`.
//!
//! A NIP-17 gift wrap is validated before it is stored — one `p` tag naming a 64-character
//! lowercase hex recipient, and content that is a structurally valid NIP-44 v2 payload — then
//! `EventRepository::create`, `["OK",<id>,true,""]` or `"duplicate:"`, and a broadcast only on
//! insert. A refusal is `["OK",<id>,false,"invalid: <reason>"]` and stores nothing.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use nostream_core::nip44::validate_payload;
use nostream_core::{Event, Pubkey};

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::{EventStrategy, event_record};

/// The `gift_wrap` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct GiftWrapStrategy;

impl EventStrategy for GiftWrapStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            if let Some(reason) = validate_gift_wrap(event) {
                context.send_ok(event.id, false, &format!("invalid: {reason}"), None);

                return Ok(());
            }

            let record = event_record(event, context);
            let count = context.stores.events.create(&record).await?;

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

/// `validateGiftWrap` (`gift-wrap-event-strategy.ts:36-60`): NIP-17 allows exactly one
/// recipient per wrap, and the payload must look like a NIP-44 v2 message.
fn validate_gift_wrap(event: &Event) -> Option<String> {
    let recipients: Vec<&Vec<String>> = event
        .tags
        .iter()
        .filter(|tag| tag.len() >= 2 && tag[0] == "p")
        .collect();

    if recipients.is_empty() {
        return Some(
            "gift wrap event (kind 1059) must have a p tag identifying the recipient".to_owned(),
        );
    }

    if recipients.len() > 1 {
        return Some("gift wrap event (kind 1059) must have exactly one p tag".to_owned());
    }

    if recipients[0][1].parse::<Pubkey>().is_err() {
        return Some(
            "gift wrap event (kind 1059) p tag must contain a valid 64-character lowercase hex pubkey"
                .to_owned(),
        );
    }

    validate_payload(&event.content)
        .map(|reason| format!("gift wrap content must be a valid NIP-44 v2 payload: {reason}"))
}
