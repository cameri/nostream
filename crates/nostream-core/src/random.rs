//! The server's randomness, behind a seam so a recorded fixture can replay it.
//!
//! Two values in the wire protocol are server-minted at random: the NIP-42 challenge (32 bytes)
//! and a NIP-43 invite code (16 bytes). A differential fixture has to compare frames
//! byte-for-byte, including the signatures over those values, so the recording and the replay
//! must draw the same bytes (R29's "determinism seams are the fixture's, not the code's").
//!
//! [`SystemRandom`] is what the daemon runs. [`SeededRandom`] is the stream
//! `crates/nostream-relay/tests/capture/gen-wire-sessions.mjs` also implements: SplitMix64 over
//! the fixture's declared seed, eight bytes per draw, little-endian. Both sides keep one
//! generator per socket, drawing the challenge first and the invite code later, so the order is
//! the fixture's to fix.

use std::sync::Mutex;

use crate::error::CoreError;

/// A source of random bytes, one length at a time.
pub trait RandomSource: Send + Sync + std::fmt::Debug {
    /// `len` bytes from the stream.
    fn bytes(&self, len: usize) -> Result<Vec<u8>, CoreError>;
}

/// `crypto.randomBytes`: the daemon's source.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemRandom;

impl RandomSource for SystemRandom {
    fn bytes(&self, len: usize) -> Result<Vec<u8>, CoreError> {
        let mut buffer = vec![0u8; len];

        getrandom::fill(&mut buffer)
            .map_err(|error| CoreError::InvalidMessage(format!("entropy: {error}")))?;

        Ok(buffer)
    }
}

/// SplitMix64, the fixture's stream. Same arithmetic as the generator's `next()`.
#[derive(Debug)]
pub struct SeededRandom {
    state: Mutex<u64>,
}

impl SeededRandom {
    /// The stream for `seed`, at its first draw.
    pub fn new(seed: u64) -> Self {
        Self {
            state: Mutex::new(seed),
        }
    }

    fn next(&self) -> u64 {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);

        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);

        z ^ (z >> 31)
    }
}

impl RandomSource for SeededRandom {
    fn bytes(&self, len: usize) -> Result<Vec<u8>, CoreError> {
        let mut bytes = Vec::with_capacity(len);

        while bytes.len() < len {
            bytes.extend_from_slice(&self.next().to_le_bytes());
        }

        bytes.truncate(len);

        Ok(bytes)
    }
}

/// The draws a recording used, replayed in order. The differential fixture records the
/// challenge and the invite code each session's relay minted, so the replay hands the relay
/// the same bytes rather than depending on a generator's position in a shared stream.
#[derive(Debug, Default)]
pub struct RecordedRandom {
    draws: Mutex<std::collections::VecDeque<Vec<u8>>>,
}

impl RecordedRandom {
    /// A source over `draws`, in order.
    pub fn new(draws: Vec<Vec<u8>>) -> Self {
        Self {
            draws: Mutex::new(draws.into()),
        }
    }

    /// How many draws are left.
    pub fn remaining(&self) -> usize {
        self.draws
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }
}

impl RandomSource for RecordedRandom {
    fn bytes(&self, len: usize) -> Result<Vec<u8>, CoreError> {
        let mut draws = self
            .draws
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        match draws.pop_front() {
            Some(draw) if draw.len() == len => Ok(draw),
            Some(draw) => Err(CoreError::InvalidMessage(format!(
                "recorded draw is {} bytes, {len} were requested",
                draw.len()
            ))),
            None => Err(CoreError::InvalidMessage(
                "the recording has no draw left".to_owned(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn the_stream_is_the_documented_splitmix64_sequence() {
        let random = SeededRandom::new(0);

        // SplitMix64's first output from seed 0 is 0xe220_a839_7b1d_cdaf, drawn little-endian.
        assert_eq!(
            random.bytes(8).expect("bytes"),
            vec![0xaf, 0xcd, 0x1d, 0x7b, 0x39, 0xa8, 0x20, 0xe2]
        );
        // The second draw continues the stream rather than repeating it.
        assert_ne!(
            random.bytes(8).expect("bytes"),
            random.bytes(8).expect("bytes")
        );
    }

    #[test]
    fn a_prefix_and_a_longer_draw_of_one_stream_agree() {
        let short = SeededRandom::new(42).bytes(4).expect("bytes");
        let long = SeededRandom::new(42).bytes(20).expect("bytes");

        assert_eq!(short, long[..4]);
    }

    #[test]
    fn the_recorded_source_replays_in_order_and_refuses_to_invent() {
        let random = RecordedRandom::new(vec![vec![1, 2, 3, 4], vec![5, 6]]);

        assert_eq!(random.bytes(4).expect("a draw"), vec![1, 2, 3, 4]);
        assert_eq!(random.bytes(2).expect("a draw"), vec![5, 6]);
        assert_eq!(random.remaining(), 0);
        assert!(random.bytes(4).is_err());
        assert!(random.bytes(2).is_err(), "and it stays exhausted");
    }

    #[test]
    fn a_recorded_draw_of_the_wrong_length_is_an_error() {
        let random = RecordedRandom::new(vec![vec![1, 2, 3]]);

        assert!(random.bytes(4).is_err());
    }

    #[test]
    fn the_system_source_fills_and_differs() {
        let random = SystemRandom;

        assert_eq!(random.bytes(16).expect("bytes").len(), 16);
        assert_ne!(
            random.bytes(16).expect("bytes"),
            random.bytes(16).expect("bytes")
        );
    }
}
