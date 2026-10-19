//! Replaceable-event precedence.
//!
//! The capture has no function for this decision: `ReplaceableEventStrategy.execute` only
//! calls `eventRepository.upsert` (`src/handlers/event-strategies/replaceable-event-strategy.ts:17-24`)
//! and the precedence lives in SQL. These are the two statements it lives in,
//! `src/repositories/event-repository.ts:404-410` (`:442-453` is the batch form):
//!
//! ```sql
//! .where(e.created_at < new.created_at OR (e.created_at = new.created_at AND e.event_id > new.event_id))
//! ```
//!
//! Read backwards, that predicate is the rule for whether a candidate replaces the stored
//! event: the candidate wins when it is newer, or when it has the same `created_at` and the
//! lexicographically **smaller** id (the SQL updates the stored row only when the stored id
//! is the larger one). `EventId`'s `Ord` is byte order, which is the same order Postgres
//! `bytea` comparison produces.

use crate::event::{Event, EventId};

/// Whether `candidate` takes the place of the stored event with `stored_created_at` and
/// `stored_id`.
pub fn supersedes(candidate: &Event, stored_created_at: i64, stored_id: &EventId) -> bool {
    candidate.created_at > stored_created_at
        || (candidate.created_at == stored_created_at && candidate.id < *stored_id)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::event::{Kind, Pubkey, Signature};

    fn event_at(created_at: i64, id: &str) -> Event {
        Event {
            id: id.parse().unwrap(),
            pubkey: Pubkey::from_byte_array([2; 32]),
            created_at,
            kind: Kind::TEXT_NOTE,
            tags: Vec::new(),
            content: String::new(),
            sig: Signature::from_byte_array([0; 64]),
        }
    }

    const LOW: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const HIGH: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    #[test]
    fn supersedes_a_newer_candidate() {
        let candidate = event_at(2000, HIGH);

        assert!(supersedes(&candidate, 1000, &LOW.parse().unwrap()));
    }

    #[test]
    fn supersedes_an_older_candidate_never_wins() {
        let candidate = event_at(999, LOW);

        assert!(!supersedes(&candidate, 1000, &HIGH.parse().unwrap()));
    }

    #[test]
    fn supersedes_at_equal_time_keeps_the_smaller_id() {
        let candidate = event_at(1000, LOW);
        let stored: EventId = HIGH.parse().unwrap();

        assert!(supersedes(&candidate, 1000, &stored));
    }

    #[test]
    fn supersedes_at_equal_time_loses_with_the_larger_id() {
        let candidate = event_at(1000, HIGH);
        let stored: EventId = LOW.parse().unwrap();

        assert!(!supersedes(&candidate, 1000, &stored));
    }

    #[test]
    fn supersedes_at_equal_time_with_the_same_id_is_false() {
        let candidate = event_at(1000, LOW);
        let stored: EventId = LOW.parse().unwrap();

        assert!(!supersedes(&candidate, 1000, &stored));
    }

    #[test]
    fn supersedes_compares_bytes_not_hex_case() {
        // `ff..ff` is the larger byte string and also the larger lowercase hex string, so
        // the two orders agree; the test pins that an id near the top of the range still
        // compares by value.
        let candidate = event_at(
            1000,
            "7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        );

        assert!(supersedes(&candidate, 1000, &HIGH.parse().unwrap()));
    }
}
