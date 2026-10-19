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
/// The value is parsed the way `Number(value)` does it: finite, integral, greater than
/// zero and no higher than [`MAX_EXPIRATION_TIME`]. `"a"`, `"0"`, a millisecond-scale
/// timestamp and a value beyond the column bound all yield `None`.
pub fn get_event_expiration(event: &Event) -> Option<u32> {
    let raw = event
        .tags
        .iter()
        .find(|tag| tag.len() >= 2 && tag[0] == "expiration")
        .map(|tag| tag[1].as_str())?;

    let value: f64 = raw.parse().ok()?;

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
}
