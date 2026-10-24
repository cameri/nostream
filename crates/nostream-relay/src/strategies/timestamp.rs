//! The `timestamp` event strategy. Mirrors
//! `src/handlers/event-strategies/timestamp-event-strategy.ts`.
//!
//! NIP-03 kind 1040. Unlike most kinds, a structurally invalid attestation is refused before it
//! is stored: a timestamp that does not commit to the event it names is worse than useless to a
//! client. Seven structural rules run first — one `e` tag naming a 32-byte lowercase hex event
//! id, and at most one `k` tag holding a non-negative integer kind — and then the OpenTimestamps
//! proof itself, whose sha256 digest must equal the `e`-tagged id and which must carry at least
//! one Bitcoin attestation. After that it is the common create-or-dedupe.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use nostream_core::nip03::validate_ots_proof;
use nostream_core::{Event, EventId};

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::{EventStrategy, event_record};

/// The `timestamp` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct TimestampStrategy;

impl EventStrategy for TimestampStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            if let Some(reason) = validate(event) {
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

/// `validate` (`timestamp-event-strategy.ts:51-91`): the structural rules, then the proof.
fn validate(event: &Event) -> Option<String> {
    let attested: Vec<&Vec<String>> = event
        .tags
        .iter()
        .filter(|tag| tag.len() >= 2 && tag[0] == "e")
        .collect();

    if attested.is_empty() {
        return Some(
            "opentimestamps event (kind 1040) must have an e tag referencing the attested event"
                .to_owned(),
        );
    }

    if attested.len() > 1 {
        // A proof commits to one digest, so more than one `e` tag would let a publisher
        // mis-attribute a valid proof to unrelated events.
        return Some(
            "opentimestamps event (kind 1040) must reference exactly one event".to_owned(),
        );
    }

    let target = &attested[0][1];

    // `EventId`'s parser is the rule the capture's `/^[0-9a-f]{64}$/` states, so the refusal
    // and the id the proof is checked against are the same decision.
    let Ok(target_event_id) = target.parse::<EventId>() else {
        return Some(
            "opentimestamps e tag must contain a 32-byte lowercase hex event id".to_owned(),
        );
    };

    let kinds: Vec<&Vec<String>> = event
        .tags
        .iter()
        .filter(|tag| tag.len() >= 2 && tag[0] == "k")
        .collect();

    if kinds.len() > 1 {
        return Some("opentimestamps event (kind 1040) must have at most one k tag".to_owned());
    }

    if let Some(kind) = kinds.first()
        && !is_non_negative_integer(&kind[1])
    {
        return Some("opentimestamps k tag must be a non-negative integer kind".to_owned());
    }

    validate_ots_proof(&event.content, &target_event_id).err()
}

/// The capture's `/^\d+$/` plus its `Number.isInteger` and `>= 0` tests: a run of ASCII digits
/// that fits a `u64` (the capture's `Number` accepts more, which no case exercises).
fn is_non_negative_integer(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}
