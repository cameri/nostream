//! Rate limiting. Mirrors `src/utils/sliding-window-rate-limiter.ts` and
//! `src/utils/ewma-rate-limiter.ts`.

use crate::error::RelayError;

/// The knobs a limiter reads from settings (`src/@types/settings.ts` `RateLimit`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateLimitConfig {
    pub period_ms: u64,
    pub rate: u64,
}

/// A fixed-window or sliding-window counter.
#[derive(Debug, Clone, Default)]
pub struct SlidingWindowRateLimiter;

impl SlidingWindowRateLimiter {
    /// Counts one event and reports whether it is under the limit.
    ///
    /// Phase 1 stub — job 005; will slide the window and count hits per key; see `src/utils/sliding-window-rate-limiter.ts`.
    pub fn hit(&self, _key: &str, _config: &RateLimitConfig) -> Result<bool, RelayError> {
        Err(RelayError::NotImplemented {
            module: "relay::limits::SlidingWindowRateLimiter::hit",
        })
    }
}

/// An exponentially weighted moving average limiter (`strategy: ewma`).
#[derive(Debug, Clone, Default)]
pub struct EwmaRateLimiter;

impl EwmaRateLimiter {
    /// Counts one event and reports whether it is under the limit.
    ///
    /// Phase 1 stub — job 005; will update the EWMA and compare against the rate; see `src/utils/ewma-rate-limiter.ts`.
    pub fn hit(&self, _key: &str, _config: &RateLimitConfig) -> Result<bool, RelayError> {
        Err(RelayError::NotImplemented {
            module: "relay::limits::EwmaRateLimiter::hit",
        })
    }
}
