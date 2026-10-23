//! The one clock abstraction. Mirrors the capture's `Date.now()` call sites.
//!
//! No other module reads the system clock: the relay's rate limiters, NIP-42 sessions,
//! `created_at` windows, NIP-40 expiry checks and invite-code expirations take a
//! [`Clock`]. Production uses [`SystemClock`]; tests use [`TestClock`], whose instant can be
//! set and advanced, which is what makes the differential fixture's frozen time replayable.
//!
//! The capture has no seam at all — `Date.now()` is read inside `isExpiredEvent`, the EWMA
//! Lua script, the sliding-window Lua script and the NIP-42 session — so this module is the
//! rewrite's addition, recorded in ADR 0004.

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// The process clock, in Unix milliseconds and seconds.
pub trait Clock: Send + Sync + std::fmt::Debug {
    /// The current Unix time in milliseconds — `Date.now()`.
    fn now_ms(&self) -> u64;

    /// The current Unix time in whole seconds — `Math.floor(Date.now() / 1000)`.
    fn now_secs(&self) -> i64 {
        i64::try_from(self.now_ms() / 1000).unwrap_or(i64::MAX)
    }
}

/// The wall clock, used by the daemon.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        // The workspace's one system-clock read; every other module is handed a Clock.
        let reading = SystemTime::now();
        reading
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(0)
    }
}

/// A settable clock for tests and the differential fixture.
#[derive(Debug, Clone)]
pub struct TestClock {
    millis: std::sync::Arc<AtomicI64>,
}

impl TestClock {
    /// A clock frozen at `start_ms`.
    pub fn new(start_ms: u64) -> Self {
        Self {
            millis: std::sync::Arc::new(AtomicI64::new(
                i64::try_from(start_ms).unwrap_or(i64::MAX),
            )),
        }
    }

    /// Moves the clock to `now_ms`.
    pub fn set(&self, now_ms: u64) {
        self.millis
            .store(i64::try_from(now_ms).unwrap_or(i64::MAX), Ordering::SeqCst);
    }

    /// Moves the clock forward by `delta_ms`.
    pub fn advance(&self, delta_ms: u64) {
        let delta = i64::try_from(delta_ms).unwrap_or(i64::MAX);
        self.millis.fetch_add(delta, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.millis.load(Ordering::SeqCst)).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn system_clock_is_plausible() {
        assert!(SystemClock.now_ms() > 1_600_000_000_000);
        assert!(SystemClock.now_secs() > 1_600_000_000);
    }

    #[test]
    fn test_clock_is_frozen_until_it_moves() {
        let clock = TestClock::new(1_700_000_000_000);

        assert_eq!(clock.now_ms(), 1_700_000_000_000);
        assert_eq!(clock.now_secs(), 1_700_000_000);

        clock.advance(1_500);
        assert_eq!(clock.now_secs(), 1_700_000_001);
        assert_eq!(
            (*std::sync::Arc::new(clock.clone())).now_ms(),
            1_700_000_001_500
        );

        clock.set(0);
        assert_eq!(clock.now_ms(), 0);
        assert_eq!(clock.now_secs(), 0);
    }
}
