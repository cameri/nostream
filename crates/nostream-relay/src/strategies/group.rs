//! The `group` event strategy. Mirrors `src/handlers/event-strategies/group-event-strategy.ts`.
//!
//! MIP-03: a kind-445 group event must carry exactly one `h` tag whose value is the 64-character
//! lowercase hex `nostr_group_id` from the Marmot Group Data Extension — otherwise an `#h`
//! subscription silently matches the wrong events. After that it is the common
//! create-or-dedupe: `EventRepository::create`, `["OK",<id>,true,""]` or `"duplicate:"`, and a
//! broadcast only on insert.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::{EventStrategy, event_record, is_lowercase_hex64};

/// The `group` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct GroupStrategy;

impl EventStrategy for GroupStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            if let Some(reason) = validate_group_event(event) {
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

/// `validateGroupEvent` (`group-event-strategy.ts:38-55`).
fn validate_group_event(event: &Event) -> Option<String> {
    let groups: Vec<&Vec<String>> = event
        .tags
        .iter()
        .filter(|tag| tag.len() >= 2 && tag[0] == "h")
        .collect();

    if groups.is_empty() {
        return Some("group event (kind 445) must have an h tag identifying the group".to_owned());
    }

    if groups.len() > 1 {
        return Some("group event (kind 445) must have exactly one h tag".to_owned());
    }

    if !is_lowercase_hex64(&groups[0][1]) {
        return Some(
            "group event (kind 445) h tag must contain a valid 64-character lowercase hex group id"
                .to_owned(),
        );
    }

    None
}
