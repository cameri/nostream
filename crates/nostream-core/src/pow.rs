//! Proof-of-work. Mirrors `src/utils/proof-of-work.ts` (NIP-13 difficulty).
//!
//! Load-scaled difficulty (`src/utils/adaptive-pow.ts`) is relay policy and stays
//! `adaptive_pow.rs`'s stub; this module is the difficulty calculation only.

use crate::event::Event;

/// Counts the leading zero bits of a byte string (`getLeadingZeroBits`,
/// `src/utils/proof-of-work.ts:1-11`): eight per zero byte, then the leading zero bits of
/// the first non-zero byte. An empty input is zero.
pub fn leading_zero_bits(bytes: &[u8]) -> u32 {
    let mut total = 0;

    for byte in bytes {
        let bits = byte.leading_zeros();
        total += bits;

        if bits != 8 {
            break;
        }
    }

    total
}

/// Whether the event id carries at least `difficulty` leading zero bits
/// (`getEventProofOfWork`, `src/utils/event.ts:278-280`, against
/// `src/handlers/event-message-handler.ts:236`).
pub fn check(event: &Event, difficulty: u32) -> bool {
    leading_zero_bits(event.id.as_bytes()) >= difficulty
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::event::{EventId, Kind, Pubkey, Signature};

    #[test]
    fn leading_zero_bits_counts_eight_per_zero_byte() {
        assert_eq!(leading_zero_bits(&[]), 0);
        assert_eq!(leading_zero_bits(&[0xff]), 0);
        assert_eq!(leading_zero_bits(&[0x80]), 0);
        assert_eq!(leading_zero_bits(&[0x01]), 7);
        assert_eq!(leading_zero_bits(&[0x00, 0x01]), 15);
        assert_eq!(leading_zero_bits(&[0; 32]), 256);
    }

    #[test]
    fn check_compares_against_the_id_bytes() {
        let event = Event {
            id: EventId::from_byte_array([0; 32]),
            pubkey: Pubkey::from_byte_array([1; 32]),
            created_at: 0,
            kind: Kind::TEXT_NOTE,
            tags: Vec::new(),
            content: String::new(),
            sig: Signature::from_byte_array([0; 64]),
        };

        assert!(check(&event, 256));
        assert!(!check(&event, 257));
    }
}
