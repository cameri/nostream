//! The `delete` event strategy. Mirrors `src/handlers/event-strategies/delete-event-strategy.ts`.
//!
//! A NIP-09 request: every `e` tag whose value parses as an event id is soft-deleted — exact
//! 32 bytes of lowercase hex, which is what `EventId`'s own parser accepts — and every `a` tag
//! naming one of the author's addressable events resolves to that event's id (`09.md`
//! §"Deletion Request" covers both the event id and the addressable `a` form). The deletions run
//! **before** the request itself is stored, so a client that re-reads after the `OK` sees them
//! already applied. Then the common create-or-dedupe.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use futures_util::StreamExt;
use nostream_core::{Event, EventId, Filter, Kind, Pubkey};

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
            let mut ids: Vec<EventId> = event
                .tags
                .iter()
                .filter(|tag| tag.len() >= 2 && tag[0] == "e")
                .filter_map(|tag| tag[1].parse::<EventId>().ok())
                .collect();

            for address in addresses(event) {
                if let Some(id) = resolve(&address, event, context).await? {
                    ids.push(id);
                }
            }

            if !ids.is_empty() {
                context
                    .stores
                    .events
                    .delete_by_pubkey_and_ids(&event.pubkey, &ids)
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
/// another author is not this request's to delete: the pubkey must be the request's own. The
/// storage call re-checks the author as a second, independent guard.
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

/// The addressable row an address names, if it is still live and no newer than the request.
///
/// Addressable kinds are stored one live row per `(pubkey, kind, d)` (`parameterized_replaceable`
/// makes the first `d` tag the deduplication key), so the author's rows of that kind are read and
/// the one whose first `d` tag equals the address's is kept. `09.md` asks for *"all versions …
/// up to the `created_at` timestamp of the deletion request"*, so a row newer than the request
/// survives.
async fn resolve(
    address: &Address,
    request: &Event,
    context: &HandlerContext,
) -> Result<Option<EventId>, RelayError> {
    let filters = [Filter {
        kinds: Some(vec![address.kind]),
        authors: Some(vec![request.pubkey.to_string()]),
        ..Default::default()
    }];

    let mut rows = context.stores.events.find_by_filters(&filters).await?;

    while let Some(row) = rows.next().await {
        let row = row?;

        if row.deleted_at.is_some() {
            continue;
        }

        let stored = &row.event;

        if d_identifier(stored) != address.d || stored.created_at > request.created_at {
            continue;
        }

        return Ok(Some(stored.id));
    }

    Ok(None)
}

/// The value of an event's first `d` tag, `""` when it carries none — the same key the
/// addressable strategy deduplicates on.
fn d_identifier(event: &Event) -> &str {
    event
        .tags
        .iter()
        .find(|tag| tag.len() >= 2 && tag[0] == "d")
        .map(|tag| tag[1].as_str())
        .unwrap_or_default()
}
