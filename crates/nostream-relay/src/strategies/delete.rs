//! The `delete` event strategy. Mirrors `src/handlers/event-strategies/delete-event-strategy.ts`.
//!
//! A NIP-09 request names its targets two ways, and each is one storage operation:
//!
//! - an `e` tag whose value parses as an event id — exact 32 bytes of lowercase hex, which is
//!   what `EventId`'s own parser accepts — goes to `delete_by_pubkey_and_ids`;
//! - an `a` tag naming `<kind>:<pubkey>:<d>` goes to `delete_by_address`, which resolves and
//!   deletes in the store (see [`EventRepository::delete_by_address`]).
//!
//! The second is deliberately *not* "read the row, then delete its id": a read is bounded by
//! the backend's page, so an address could sit outside it, and a read and a delete are two
//! operations, so a replacement landing between them would survive the delete the client was
//! told had happened. One operation per address is what makes the `OK` true.
//!
//! The deletions run **before** the request itself is stored, so a client that re-reads after
//! the `OK` sees them already applied. Then the common create-or-dedupe.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use nostream_core::{Event, EventId, Kind, Pubkey};

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::{EventStrategy, event_record};

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
            let ids: Vec<EventId> = event
                .tags
                .iter()
                .filter(|tag| tag.len() >= 2 && tag[0] == "e")
                .filter_map(|tag| tag[1].parse::<EventId>().ok())
                .collect();

            if !ids.is_empty() {
                context
                    .stores
                    .events
                    .delete_by_pubkey_and_ids(&event.pubkey, &ids)
                    .await?;
            }

            for address in addresses(event) {
                context
                    .stores
                    .events
                    .delete_by_address(&event.pubkey, address.kind, &address.d, event.created_at)
                    .await?;
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

/// One `a` tag's address, kept only when the request may name it.
struct Address {
    kind: Kind,
    /// The `d` identifier, `""` for a tag that omits it — the key the addressable strategy
    /// stores a row without a `d` tag under.
    d: String,
}

/// The addresses a deletion request may act on: `<kind>:<pubkey>:<d>`, split into at most three
/// parts so a `d` may hold colons of its own.
///
/// `09.md`'s `a` branch is about addressable events, and only those carry a `d` in their
/// address, so a regular replaceable kind named by an `a` tag is ignored. An address naming
/// another author is not this request's to delete: the pubkey must be the request's own, and
/// the store's delete re-checks the author as a second, independent guard.
fn addresses(event: &Event) -> Vec<Address> {
    event
        .tags
        .iter()
        .filter(|tag| tag.len() >= 2 && tag[0] == "a")
        .filter_map(|tag| {
            let mut parts = tag[1].splitn(3, ':');
            let kind = Kind(parts.next()?.parse::<u64>().ok()?);
            let pubkey = parts.next()?.parse::<Pubkey>().ok()?;
            let d = parts.next().unwrap_or_default().to_owned();

            (kind.is_parameterized_replaceable() && pubkey == event.pubkey)
                .then_some(Address { kind, d })
        })
        .collect()
}
