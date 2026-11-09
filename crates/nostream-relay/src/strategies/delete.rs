//! The `delete` event strategy. Mirrors `src/handlers/event-strategies/delete-event-strategy.ts`.
//!
//! A NIP-09 request names its targets two ways, and each is one storage call for the whole
//! request:
//!
//! - an `e` tag whose value parses as an event id — exact 32 bytes of lowercase hex, which is
//!   what `EventId`'s own parser accepts — goes to `delete_by_pubkey_and_ids`;
//! - an `a` tag naming `<kind>:<pubkey>:<d>` goes to `delete_by_addresses`, which resolves and
//!   deletes the whole batch in one transaction (see [`EventRepository::delete_by_addresses`]).
//!
//! The second is deliberately *not* "read the row, then delete its id": a read is bounded by
//! the backend's page, so an address could sit outside it, and a read and a delete are two
//! operations, so a replacement landing between them would survive the delete the client was
//! told had happened. One operation per request is what makes the `OK` true.
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

/// The most distinct `(kind, d)` addresses one deletion request may name.
///
/// This is a policy, and the number is derived rather than felt, so the next reader can re-check
/// it against the arithmetic instead of trusting it:
///
/// - **what one admission gate allows.** `maxPayloadSize` is 524 288 bytes and an `a` tag costs
///   about 86 (`["a","30023:<64 hex>:<d>"]`), so the transport alone admits ~6 096 tags. Nothing
///   else caps a tag list, so without this constant that is the count the store would see.
/// - **what one address costs.** One `replaceable` point lookup and one row decode, measured at
///   0.0395 ms; 100 of them are ~4 ms of one write transaction. The batch is one transaction, so
///   the cost is one commit's latency, not 100.
/// - **what a key can ask for.** Kind 5 is limited to 30 events/min per free key, so 30 × 100 =
///   3 000 address-deletes/min, ~120 ms of writer time per minute — 0.2 % of the single LMDB
///   writer. The same key at the transport's 6 096 would be ~180× that: 30 × 6 096 × 0.04 ms
///   ≈ 7.3 s of writer time per minute, i.e. seven writers' worth from one free key. That is the
///   number this cap exists to overrule.
///
/// A request naming more is **refused**, `["OK",<id>,false,"invalid: …"]`, before anything is
/// deleted or stored. Refusing is the kindest correct answer: the alternative — deleting the first
/// 100 and answering `true` — would tell the client its other articles were deleted when they were
/// not, and a partial delete answered `false` would already have changed the store while claiming
/// it had not. A refusal changes nothing, so the client can retry with the addresses split across
/// requests, which is what the per-request reading of `09.md` asks for anyway.
const MAX_ADDRESSES_PER_REQUEST: usize = 100;

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
            let addresses = addresses(event);

            if addresses.len() > MAX_ADDRESSES_PER_REQUEST {
                context.send_ok(
                    event.id,
                    false,
                    &format!(
                        "invalid: a deletion request may name at most \
                         {MAX_ADDRESSES_PER_REQUEST} addresses"
                    ),
                    None,
                );

                return Ok(());
            }

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

            if !addresses.is_empty() {
                context
                    .stores
                    .events
                    .delete_by_addresses(&event.pubkey, &addresses, event.created_at)
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

/// The distinct `(kind, d)` addresses a deletion request may act on, in the order they appear.
///
/// `09.md`'s `a` branch is about addressable events, and only those carry a `d` in their address,
/// so a regular replaceable kind named by an `a` tag is ignored (`Kind::is_parameterized_replaceable`
/// is 30 000–39 999). An address naming another author is not this request's to delete: the pubkey
/// must be the request's own, and the store re-checks the row's author as a second, independent
/// guard. A tag whose kind does not parse, whose pubkey does not parse, or that carries no kind or
/// pubkey at all is ignored.
///
/// The `d` is the third part and may hold colons of its own, which is why the split stops at three
/// parts; a tag with no third part names the empty `d`, the same address the addressable strategy
/// gives a row with no `d` tag. Duplicates collapse to one address, so `[["a",A],["a",A]]` costs the
/// store one lookup rather than two, and the count the cap bounds is the work's, not the tags'.
fn addresses(event: &Event) -> Vec<(Kind, String)> {
    let mut addresses: Vec<(Kind, String)> = Vec::new();

    for tag in &event.tags {
        if tag.len() < 2 || tag[0] != "a" {
            continue;
        }

        let mut parts = tag[1].splitn(3, ':');
        let Some(kind) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
            continue;
        };
        let Some(pubkey) = parts.next().and_then(|part| part.parse::<Pubkey>().ok()) else {
            continue;
        };
        let kind = Kind(kind);

        if !kind.is_parameterized_replaceable() || pubkey != event.pubkey {
            continue;
        }

        let d = parts.next().unwrap_or_default();
        let address = (kind, d.to_owned());

        if !addresses.contains(&address) {
            addresses.push(address);
        }
    }

    addresses
}
