//! Event validation against the base schema. Mirrors `src/utils/validation.ts`,
//! `src/schemas/event-schema.ts` and the id/signature half of `src/utils/event.ts`
//! (`isEventIdValid`, `isEventSignatureValid`).
//!
//! [`validate_event`] is the schema check the codec runs before a frame reaches a handler;
//! [`validate_event_fields`] is the same check at the value level, where it can report the
//! schema's own message for a malformed field (the NOTICE carries it). The two share
//! [`check_event_shape`], so the typed and untyped entry points cannot disagree.

use crate::error::CoreError;
use crate::event::{Event, Kind, Tag};

/// The geohash alphabet (`GEOHASH_BASE32`, `src/utils/geohash.ts:2`).
const GEOHASH_BASE32: &str = "0123456789bcdefghjkmnpqrstuvwxyz";

/// The largest integer JavaScript represents exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// The exclusive upper bound of `createdAtSchema` (`Math.log10(value) < 10`).
const CREATED_AT_LIMIT: i64 = 10_000_000_000;

/// Kind 7, `EventKinds.REACTION`.
const REACTION_KIND: Kind = Kind(7);

/// Kind 17, `EventKinds.EXTERNAL_CONTENT_REACTION`.
const EXTERNAL_CONTENT_REACTION_KIND: Kind = Kind(17);

/// Kind 10002, `EventKinds.RELAY_LIST`.
const RELAY_LIST_KIND: Kind = Kind(10_002);

/// Validates an event against the base schema (`eventSchema.parse`, `src/schemas/event-schema.ts`).
///
/// The hex fields' length and alphabet are carried by [`EventId`](crate::event::EventId),
/// [`Pubkey`] and [`Signature`], so what is left is `created_at`, the tag tuples, and the
/// kind-7/17/10002/geohash refinements.
pub fn validate_event(event: &Event) -> Result<(), CoreError> {
    check_event_shape(event).map_err(CoreError::InvalidEvent)
}

/// The conformance checks `validate_event` applies, reporting the schema's message.
fn check_event_shape(event: &Event) -> Result<(), String> {
    if event.created_at < 0 {
        return Err("Number must be greater than or equal to 0".to_owned());
    }

    if event.created_at > MAX_SAFE_INTEGER || event.created_at >= CREATED_AT_LIMIT {
        return Err("Invalid timestamp".to_owned());
    }

    for tag in &event.tags {
        check_tag(tag)?;
    }

    check_refinements(event)
}

fn check_tag(tag: &Tag) -> Result<(), String> {
    if tag.is_empty() {
        return Err("Array must contain at least 1 element(s)".to_owned());
    }

    if tag[0].is_empty() {
        return Err("String must contain at least 1 character(s)".to_owned());
    }

    Ok(())
}

/// The `superRefine` block of `eventSchema` (`src/schemas/event-schema.ts:42-94`), in the
/// same order: kind 7, else kind 17, else the relay-list rule, then the geohash rule for
/// every event.
fn check_refinements(event: &Event) -> Result<(), String> {
    if event.kind == REACTION_KIND {
        let has_target = event.tags.iter().any(|tag| {
            matches!(tag.first().map(String::as_str), Some("e" | "a"))
                && tag.get(1).is_some_and(|value| !value.is_empty())
        });

        if !has_target {
            return Err("Reaction event (kind 7) must have at least one e or a tag".to_owned());
        }
    } else if event.kind == EXTERNAL_CONTENT_REACTION_KIND {
        let has_kind_tag = event.tags.iter().any(|tag| {
            tag.first().map(String::as_str) == Some("k")
                && tag.get(1).is_some_and(|v| !v.is_empty())
        });
        let has_index_tag = event.tags.iter().any(|tag| {
            tag.first().map(String::as_str) == Some("i")
                && tag.get(1).is_some_and(|v| !v.is_empty())
        });

        if !has_kind_tag || !has_index_tag {
            return Err(
                "External content reaction event (kind 17) must have k and i tags".to_owned(),
            );
        }
    } else if event.kind == RELAY_LIST_KIND {
        for tag in &event.tags {
            if tag.first().map(String::as_str) == Some("r")
                && !tag.get(1).is_some_and(|url| is_valid_url(url))
            {
                return Err("Invalid relay URL".to_owned());
            }
        }
    }

    for tag in &event.tags {
        if tag.first().map(String::as_str) == Some("g")
            && !tag.get(1).is_some_and(|value| is_geohash(value))
        {
            return Err("Invalid geohash".to_owned());
        }
    }

    Ok(())
}

/// `GEOHASH_PATTERN`: one or more base32 characters (`src/utils/geohash.ts:6`).
fn is_geohash(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| GEOHASH_BASE32.contains(character))
}

/// `z.string().url()`, which is WHATWG `new URL(value)` behind a try/catch: an absolute URL
/// with a scheme and a non-empty host.
fn is_valid_url(value: &str) -> bool {
    match url::Url::parse(value) {
        Ok(url) => url.host_str().is_some_and(|host| !host.is_empty()),
        Err(_) => false,
    }
}
