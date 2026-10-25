//! The per-IP live-connection cap: a gauge, beside the attempt limiter and not part of it.
//!
//! `limits.rs` answers "how fast may this address open connections" over a sliding window;
//! this answers "how many may it hold at once". The capture has neither question
//! (`src/@types/settings.ts:163-167`: `ConnectionLimits` is `rateLimits`, `ipWhitelist` and
//! `ipBlacklist`), so the cap is the port's own policy with no counterpart there (ADR 0008).
//!
//! Two things it deliberately is not. It is not a second `RateLimits` store: no window, no
//! clock, no whitelist, nothing to expire — a count that only `Drop` changes. And it is not
//! advisory: the connection task holds a [`ConnectionSlot`] for as long as the socket lives,
//! so an address at the cap is refused before the NIP-42 challenge is sent rather than after
//! the client has already been spoken to.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// The live sockets per source address, with the cap each is checked against (ADR 0008).
#[derive(Debug)]
pub struct ConnectionCap {
    max_per_ip: usize,
    live: Mutex<HashMap<String, usize>>,
    refusals: AtomicU64,
}

impl ConnectionCap {
    /// A cap of `max_per_ip` sockets per address, with nothing counted.
    pub fn new(max_per_ip: usize) -> Self {
        Self {
            max_per_ip,
            live: Mutex::new(HashMap::new()),
            refusals: AtomicU64::new(0),
        }
    }

    /// The most sockets one address may hold at once.
    pub fn max_per_ip(&self) -> usize {
        self.max_per_ip
    }

    /// How many sockets `ip` holds now.
    pub fn live(&self, ip: &str) -> usize {
        self.live
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(ip)
            .copied()
            .unwrap_or(0)
    }

    /// How many addresses hold a socket: an address that releases its last one leaves no entry.
    pub fn tracked_addresses(&self) -> usize {
        self.live
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    /// How many sockets were refused because their address was at the cap.
    pub fn refusals(&self) -> u64 {
        self.refusals.load(Ordering::SeqCst)
    }

    /// Takes a slot for `ip`, or counts the refusal and returns `None` at the cap.
    ///
    /// The slot releases on `Drop`, so a caller that holds it for the whole connection
    /// releases it on every exit — the normal one, a registration failure, or one added
    /// later — without a decrement at each.
    pub fn acquire(self: &Arc<Self>, ip: &str) -> Option<ConnectionSlot> {
        let mut live = self
            .live
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let held = live.get(ip).copied().unwrap_or(0);

        if held >= self.max_per_ip {
            // Nothing is inserted for a refused address: an entry that must not be there
            // would read as a socket held.
            drop(live);
            self.refusals.fetch_add(1, Ordering::SeqCst);

            return None;
        }

        live.insert(ip.to_owned(), held + 1);

        Some(ConnectionSlot {
            cap: Arc::clone(self),
            ip: ip.to_owned(),
        })
    }
}

/// One socket's slot in a [`ConnectionCap`], given back when it drops.
#[derive(Debug)]
pub struct ConnectionSlot {
    cap: Arc<ConnectionCap>,
    ip: String,
}

impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        let mut live = self
            .cap
            .live
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if let Some(held) = live.get_mut(&self.ip) {
            *held = held.saturating_sub(1);

            if *held == 0 {
                live.remove(&self.ip);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use super::*;

    #[test]
    fn the_cap_counts_live_slots_and_releases_each_once() {
        let cap = Arc::new(ConnectionCap::new(2));

        let first = cap.acquire("127.0.0.1").expect("a slot below the cap");
        let second = cap
            .acquire("127.0.0.1")
            .expect("the last slot below the cap");

        assert_eq!(cap.live("127.0.0.1"), 2);
        assert_eq!(cap.tracked_addresses(), 1);

        assert!(cap.acquire("127.0.0.1").is_none());
        assert_eq!(cap.refusals(), 1);
        assert_eq!(cap.live("127.0.0.1"), 2, "a refusal holds no slot");

        // A second address has its own count, and an address at the cap does not affect it.
        let elsewhere = cap
            .acquire("10.0.0.1")
            .expect("another address is unaffected");

        assert_eq!(cap.live("10.0.0.1"), 1);
        assert_eq!(cap.tracked_addresses(), 2);

        drop(first);

        assert_eq!(cap.live("127.0.0.1"), 1);
        assert_eq!(cap.tracked_addresses(), 2);

        drop(second);

        assert_eq!(cap.live("127.0.0.1"), 0);
        assert_eq!(
            cap.tracked_addresses(),
            1,
            "an address that releases its last slot leaves no entry"
        );

        drop(elsewhere);

        assert_eq!(cap.tracked_addresses(), 0);
        assert_eq!(cap.refusals(), 1);
    }
}
