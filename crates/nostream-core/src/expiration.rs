//! NIP-40 event expiration. Mirrors `getEventExpiration` and `isExpiredEvent`
//! (`src/utils/event.ts:244-276`).
//!
//! The reference time is an argument (`now: i64`), not a clock read: the capture reads the
//! wall clock inside `isExpiredEvent` because it has no caller that can supply one, and
//! this crate's tests and the differential fixture do.

use crate::event::Event;

/// The largest expiration the capture stores. `events.expires_at` is a Postgres signed
/// 32-bit integer column, so anything above this would fail the INSERT
/// (`src/utils/event.ts:260-263`).
pub const MAX_EXPIRATION_TIME: u32 = 2_147_483_647;

/// The event's expiration, when its first `expiration` tag holds a usable value
/// (`getEventExpiration`, `src/utils/event.ts:265-276`).
///
/// The value is parsed the way `Number(value)` parses it — surrounding whitespace trimmed,
/// `0x`/`0o`/`0b` radix prefixes read, the empty string as zero, everything else decimal —
/// and then required to be finite, integral, greater than zero and no higher than
/// [`MAX_EXPIRATION_TIME`]. `"a"`, `"0"`, a millisecond-scale timestamp and a value beyond
/// the column bound all yield `None`.
pub fn get_event_expiration(event: &Event) -> Option<u32> {
    let raw = event
        .tags
        .iter()
        .find(|tag| tag.len() >= 2 && tag[0] == "expiration")
        .map(|tag| tag[1].as_str())?;

    let value = js_number(raw)?;

    if value.is_finite()
        && value.fract() == 0.0
        && value > 0.0
        && value <= f64::from(MAX_EXPIRATION_TIME)
    {
        Some(value as u32)
    } else {
        None
    }
}

/// Whether the event has expired at `now` (`isExpiredEvent`, `src/utils/event.ts:244-258`).
///
/// An event with no tags, or with no usable expiration, never expires.
pub fn is_expired_event(event: &Event, now: i64) -> bool {
    if event.tags.is_empty() {
        return false;
    }

    match get_event_expiration(event) {
        Some(expiration) => i64::from(expiration) <= now,
        None => false,
    }
}

/// The subset of JavaScript's `Number(primitive)` a tag value can reach: `String.prototype`
/// trimming (which also removes a leading U+FEFF), the three radix prefixes, the empty string
/// as zero, and the decimal grammar `f64::from_str` shares with it. Anything JavaScript would
/// read as `NaN` (or as a value this cannot represent) is `None`, which every caller treats
/// as "no usable expiration".
fn js_number(text: &str) -> Option<f64> {
    // `char::is_whitespace` is Unicode `White_Space`; JS `trim()` additionally strips U+FEFF.
    let trimmed =
        text.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}');

    if trimmed.is_empty() {
        return Some(0.0);
    }

    let (radix, digits) =
        if let Some(digits) = trimmed.strip_prefix("0x").or(trimmed.strip_prefix("0X")) {
            (16, digits)
        } else if let Some(digits) = trimmed.strip_prefix("0o").or(trimmed.strip_prefix("0O")) {
            (8, digits)
        } else if let Some(digits) = trimmed.strip_prefix("0b").or(trimmed.strip_prefix("0B")) {
            (2, digits)
        } else {
            return trimmed.parse::<f64>().ok();
        };

    // `from_str_radix` accepts a leading sign after the prefix (`"0x+10"` → 16); JavaScript
    // reads `Number("0x+10")` as NaN, and accepting it here would expire an event the
    // capture retains.
    if digits.starts_with(['+', '-']) {
        return None;
    }

    u64::from_str_radix(digits, radix)
        .ok()
        .map(|value| value as f64)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::event::{EventId, Kind, Pubkey, Signature};

    fn event_with(tags: Vec<Vec<&str>>) -> Event {
        Event {
            id: EventId::from_byte_array([1; 32]),
            pubkey: Pubkey::from_byte_array([2; 32]),
            created_at: 1_660_896_109,
            kind: Kind::TEXT_NOTE,
            tags: tags
                .into_iter()
                .map(|tag| tag.into_iter().map(str::to_owned).collect())
                .collect(),
            content: "Hello world".to_owned(),
            sig: Signature::from_byte_array([0; 64]),
        }
    }

    #[test]
    fn expiration_of_a_safe_integer_is_returned() {
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", "160000000"]])),
            Some(160_000_000)
        );
    }

    #[test]
    fn expiration_is_none_without_an_expiration_tag() {
        assert_eq!(get_event_expiration(&event_with(Vec::new())), None);
    }

    #[test]
    fn expiration_of_an_unsafe_integer_is_none() {
        assert_eq!(
            get_event_expiration(&event_with(vec![vec![
                "expiration",
                "160000000000000000000"
            ]])),
            None
        );
    }

    #[test]
    fn expiration_of_malformed_data_is_none() {
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", "a"]])),
            None
        );
    }

    #[test]
    fn expiration_of_zero_is_none() {
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", "0"]])),
            None
        );
    }

    #[test]
    fn expiration_beyond_the_postgres_int4_maximum_is_none() {
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", "10000000000"]])),
            None
        );
    }

    #[test]
    fn expiration_at_the_maximum_unix_seconds_timestamp_is_none() {
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", "253402300799"]])),
            None
        );
    }

    #[test]
    fn expiration_at_the_column_maximum_is_returned() {
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", "2147483647"]])),
            Some(MAX_EXPIRATION_TIME)
        );
    }

    #[test]
    fn expiration_that_looks_like_milliseconds_is_none() {
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", "1700000000000"]])),
            None
        );
    }

    #[test]
    fn expiration_uses_the_first_expiration_tag() {
        assert_eq!(
            get_event_expiration(&event_with(vec![
                vec!["delegation", "abc"],
                vec!["expiration", "100"],
                vec!["expiration", "200"],
            ])),
            Some(100)
        );
    }

    #[test]
    fn expiration_ignores_a_tag_without_a_value() {
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration"]])),
            None
        );
    }

    #[test]
    fn expired_event_is_false_without_tags() {
        assert!(!is_expired_event(&event_with(Vec::new()), i64::MAX));
    }

    #[test]
    fn expired_event_is_false_without_an_expiration_tag() {
        assert!(!is_expired_event(
            &event_with(vec![vec!["e", "aa"]]),
            i64::MAX
        ));
    }

    #[test]
    fn expired_event_is_true_past_its_expiration() {
        assert!(is_expired_event(
            &event_with(vec![vec!["expiration", "100000"]]),
            100_000
        ));
    }

    #[test]
    fn expired_event_is_false_before_its_expiration() {
        assert!(!is_expired_event(
            &event_with(vec![vec!["expiration", "100000"]]),
            99_999
        ));
    }

    #[test]
    fn expired_event_boundary_is_the_expiration_instant() {
        let event = event_with(vec![vec!["expiration", "100000"]]);

        assert!(is_expired_event(&event, 100_000));
        assert!(!is_expired_event(&event, 99_999));
    }

    #[test]
    fn expiration_reads_the_forms_javascript_number_reads() {
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", " 160000000 "]])),
            Some(160_000_000)
        );
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", "0x10"]])),
            Some(16)
        );
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", "0o10"]])),
            Some(8)
        );
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", "0b101"]])),
            Some(5)
        );
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", "1e3"]])),
            Some(1_000)
        );
    }

    #[test]
    fn expiration_of_a_bare_radix_prefix_is_none() {
        // `Number("0x")` is NaN in JavaScript.
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", "0x"]])),
            None
        );
    }

    #[test]
    fn expiration_rejects_a_sign_after_the_radix_prefix() {
        // `Number("0x+10")` is NaN in JavaScript; `from_str_radix` alone would read 16 and
        // expire an event the capture retains.
        for value in ["0x+10", "0o+10", "0b+101", "0x-10"] {
            assert_eq!(
                get_event_expiration(&event_with(vec![vec!["expiration", value]])),
                None,
                "{value}"
            );
        }
    }

    #[test]
    fn expiration_strips_a_byte_order_mark_like_javascript_trim() {
        assert_eq!(
            get_event_expiration(&event_with(vec![vec!["expiration", "\u{feff}160000000"]])),
            Some(160_000_000)
        );
    }
}
