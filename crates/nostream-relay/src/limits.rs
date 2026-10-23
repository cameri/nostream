//! Rate limiting. Mirrors `src/utils/sliding-window-rate-limiter.ts`,
//! `src/utils/ewma-rate-limiter.ts`, `src/factories/rate-limiter-factory.ts` and the three
//! wiring points (`rate-limiter-middleware.ts`, `web-socket-adapter.ts:264-310`,
//! `event-message-handler.ts:376-436`, `subscribe-message-handler.ts:179-206`).
//!
//! The capture's limiters are Redis singletons executing Lua; here they are in-process
//! stores whose time comes from [`nostream_core::clock::Clock`]. The window *semantics* —
//! what is counted, what is recorded and what is refused — are the scripts' (ADR 0004).
//!
//! | script | rule |
//! |---|---|
//! | sliding window | drop scores ≤ `now − period`; `sum + step > rate` refuses **without recording**; `sum + step == rate` is allowed |
//! | EWMA | `R' = R·e^(−ln2/period·Δt) + step`, stored **before** the comparison; `R' > rate` refuses |
//!
//! Both stores expire a key after `ceil(period / 1000)` seconds, which is the TTL the
//! scripts set (`ewma-rate-limiter.ts:22`, `sliding-window-rate-limiter.ts:43`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use nostream_config::settings::{
    ConnectionLimits, EventLimits, EventRateLimit, InviteLimits, MessageLimits, MessageRateLimit,
    RateLimit, RateLimiterStrategy, Settings,
};
use nostream_core::clock::Clock;
use nostream_core::{Event, KindSelector, Pubkey};

use crate::error::RelayError;

/// The knobs a limiter reads from settings (`src/@types/settings.ts` `RateLimit`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateLimitConfig {
    pub period_ms: u64,
    pub rate: u64,
}

impl From<&RateLimit> for RateLimitConfig {
    fn from(limit: &RateLimit) -> Self {
        Self {
            period_ms: limit.period,
            rate: limit.rate,
        }
    }
}

impl From<&MessageRateLimit> for RateLimitConfig {
    fn from(limit: &MessageRateLimit) -> Self {
        Self {
            period_ms: limit.period,
            rate: limit.rate,
        }
    }
}

impl From<&EventRateLimit> for RateLimitConfig {
    fn from(limit: &EventRateLimit) -> Self {
        Self {
            period_ms: limit.period,
            rate: limit.rate,
        }
    }
}

/// One sliding-window hit: the instant it was recorded and the weight it carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SlidingEntry {
    at_ms: u64,
    step: u64,
}

/// The sliding-window store (`SLIDING_WINDOW_RATE_LIMITER_LUA_SCRIPT`).
#[derive(Debug)]
pub struct SlidingWindowRateLimiter {
    clock: Arc<dyn Clock>,
    entries: Mutex<HashMap<String, Vec<SlidingEntry>>>,
}

impl SlidingWindowRateLimiter {
    /// A limiter reading time from `clock`.
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Counts one hit and reports whether it is **limited**.
    ///
    /// The window start is inclusive on removal (`ZREMRANGEBYSCORE 0 windowStart`) and the
    /// comparison is exclusive, so `sum + step == rate` is allowed and a refused hit is not
    /// recorded.
    pub fn hit(&self, key: &str, step: u64, config: &RateLimitConfig) -> Result<bool, RelayError> {
        let now = self.clock.now_ms();
        let window_start = now.saturating_sub(config.period_ms);

        let mut store = self.store()?;
        let entries = store.entry(key.to_owned()).or_default();

        entries.retain(|entry| entry.at_ms > window_start);

        let sum = entries
            .iter()
            .fold(0u64, |total, entry| total.saturating_add(entry.step));

        if sum.saturating_add(step) > config.rate {
            return Ok(true);
        }

        entries.push(SlidingEntry { at_ms: now, step });

        Ok(false)
    }

    /// How many hits the key currently carries inside its window.
    pub fn len(&self, key: &str) -> usize {
        self.entries
            .lock()
            .map(|store| store.get(key).map_or(0, Vec::len))
            .unwrap_or(0)
    }

    /// Whether the key currently carries no hits.
    pub fn is_empty(&self, key: &str) -> bool {
        self.len(key) == 0
    }

    fn store(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, Vec<SlidingEntry>>>, RelayError> {
        self.entries
            .lock()
            .map_err(|error| RelayError::RateLimiter(format!("sliding window store: {error}")))
    }
}

/// One EWMA key: the decayed rate and the instant it was written.
#[derive(Debug, Clone, Copy, PartialEq)]
struct EwmaEntry {
    rate: f64,
    at_ms: u64,
}

/// The EWMA store (`rateLimitScript`).
#[derive(Debug)]
pub struct EwmaRateLimiter {
    clock: Arc<dyn Clock>,
    entries: Mutex<HashMap<String, EwmaEntry>>,
}

impl EwmaRateLimiter {
    /// A limiter reading time from `clock`.
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Counts one hit and reports whether it is **limited**.
    ///
    /// The new rate is stored before the comparison, so a limited hit still shapes the next
    /// one; a key whose entry is older than its `ceil(period / 1000)` s TTL starts fresh.
    pub fn hit(&self, key: &str, step: u64, config: &RateLimitConfig) -> Result<bool, RelayError> {
        let now = self.clock.now_ms();
        let ttl_ms = config.period_ms.div_ceil(1000).saturating_mul(1000);

        let mut store = self
            .entries
            .lock()
            .map_err(|error| RelayError::RateLimiter(format!("ewma store: {error}")))?;

        // The key's TTL is `ceil(period / 1000)` seconds from its last write: at that
        // instant Redis has dropped it, so the entry is gone too.
        let previous = store
            .get(key)
            .copied()
            .filter(|entry| now.saturating_sub(entry.at_ms) < ttl_ms);

        let (old_rate, old_at) = previous.map_or((0.0, now), |entry| (entry.rate, entry.at_ms));
        let delta_t = now.saturating_sub(old_at) as f64;
        let lambda = std::f64::consts::LN_2 / config.period_ms as f64;
        let rate = old_rate * (-lambda * delta_t).exp() + step as f64;

        store.insert(key.to_owned(), EwmaEntry { rate, at_ms: now });

        Ok(rate > config.rate as f64)
    }

    /// The stored rate for a key, after applying the TTL.
    pub fn rate(&self, key: &str, config: &RateLimitConfig) -> Option<f64> {
        let now = self.clock.now_ms();
        let ttl_ms = config.period_ms.div_ceil(1000).saturating_mul(1000);

        self.entries
            .lock()
            .ok()
            .and_then(|store| store.get(key).copied())
            .filter(|entry| now.saturating_sub(entry.at_ms) < ttl_ms)
            .map(|entry| entry.rate)
    }
}

/// `IRateLimiter`: one window, one verdict.
pub trait Limiter: Send + Sync + std::fmt::Debug {
    /// Counts one hit and reports whether it is limited.
    fn hit(&self, key: &str, step: u64, config: &RateLimitConfig) -> Result<bool, RelayError>;

    /// Which store is running.
    fn strategy(&self) -> RateLimiterStrategy;
}

impl Limiter for SlidingWindowRateLimiter {
    fn hit(&self, key: &str, step: u64, config: &RateLimitConfig) -> Result<bool, RelayError> {
        SlidingWindowRateLimiter::hit(self, key, step, config)
    }

    fn strategy(&self) -> RateLimiterStrategy {
        RateLimiterStrategy::SlidingWindow
    }
}

impl Limiter for EwmaRateLimiter {
    fn hit(&self, key: &str, step: u64, config: &RateLimitConfig) -> Result<bool, RelayError> {
        EwmaRateLimiter::hit(self, key, step, config)
    }

    fn strategy(&self) -> RateLimiterStrategy {
        RateLimiterStrategy::Ewma
    }
}

/// The selected limiter (`rateLimiterFactory`: `ewma` unless the settings say
/// `sliding_window`).
#[derive(Debug)]
pub enum RateLimiter {
    Ewma(EwmaRateLimiter),
    SlidingWindow(SlidingWindowRateLimiter),
}

impl RateLimiter {
    /// The limiter `limits.rateLimiter.strategy` selects, `ewma` by default.
    pub fn from_settings(settings: &Settings, clock: Arc<dyn Clock>) -> Self {
        let strategy = settings
            .limits
            .as_ref()
            .and_then(|limits| limits.rate_limiter.as_ref())
            .map_or(RateLimiterStrategy::Ewma, |limiter| limiter.strategy);

        match strategy {
            RateLimiterStrategy::SlidingWindow => {
                Self::SlidingWindow(SlidingWindowRateLimiter::new(clock))
            }
            RateLimiterStrategy::Ewma => Self::Ewma(EwmaRateLimiter::new(clock)),
        }
    }

    /// `IRateLimiter.hit(key, step, {period, rate})`: whether the hit is limited.
    pub fn hit(&self, key: &str, step: u64, config: &RateLimitConfig) -> Result<bool, RelayError> {
        match self {
            Self::Ewma(limiter) => limiter.hit(key, step, config),
            Self::SlidingWindow(limiter) => limiter.hit(key, step, config),
        }
    }

    /// Which store is running, for logging and tests.
    pub fn strategy(&self) -> RateLimiterStrategy {
        match self {
            Self::Ewma(_) => RateLimiterStrategy::Ewma,
            Self::SlidingWindow(_) => RateLimiterStrategy::SlidingWindow,
        }
    }
}

impl Limiter for RateLimiter {
    fn hit(&self, key: &str, step: u64, config: &RateLimitConfig) -> Result<bool, RelayError> {
        RateLimiter::hit(self, key, step, config)
    }

    fn strategy(&self) -> RateLimiterStrategy {
        RateLimiter::strategy(self)
    }
}

/// The four wired levels (connection, message, event, invite) over one limiter.
#[derive(Debug)]
pub struct RateLimits {
    limiter: Arc<dyn Limiter>,
    connection: Option<ConnectionLimits>,
    message: Option<MessageLimits>,
    event: Option<EventLimits>,
    invite: Option<InviteLimits>,
}

impl RateLimits {
    /// Reads every level from settings. The limiter is shared by all four, as the
    /// capture's `rateLimiterFactory` singleton is.
    pub fn new(settings: &Settings, clock: Arc<dyn Clock>) -> Self {
        Self::with_limiter(
            Arc::new(RateLimiter::from_settings(settings, clock)),
            settings,
        )
    }

    /// The four levels over an explicit limiter, which is how the store's failure path is
    /// exercised.
    pub fn with_limiter(limiter: Arc<dyn Limiter>, settings: &Settings) -> Self {
        let limits = settings.limits.as_ref();

        Self {
            limiter,
            connection: limits.and_then(|limits| limits.connection.clone()),
            message: limits.and_then(|limits| limits.message.clone()),
            event: limits.and_then(|limits| limits.event.clone()),
            invite: limits.and_then(|limits| limits.invite.clone()),
        }
    }

    /// The store the settings selected.
    pub fn strategy(&self) -> RateLimiterStrategy {
        self.limiter.strategy()
    }

    /// `limits.connection.rateLimits` with its `ipWhitelist` bypass
    /// (`rate-limiter-middleware.ts:26-53`). Every window is counted, and any trip refuses
    /// the connection.
    pub fn connection_limited(&self, address: &str) -> Result<bool, RelayError> {
        let Some(connection) = &self.connection else {
            return Ok(false);
        };

        if connection
            .ip_whitelist
            .as_ref()
            .is_some_and(|whitelist| whitelist.iter().any(|entry| entry == address))
        {
            return Ok(false);
        }

        let mut limited = false;

        for window in &connection.rate_limits {
            let config = RateLimitConfig::from(window);
            let key = format!("{address}:connection:{}", config.period_ms);

            if self.limiter.hit(&key, 1, &config)? {
                limited = true;
            }
        }

        Ok(limited)
    }

    /// `limits.message.rateLimits` with its `ipWhitelist` bypass
    /// (`web-socket-adapter.ts:264-282`). `Ok(Some(backoff))` is the message not being
    /// handled; `Ok(None)` is allowed.
    pub fn message_backoff(&self, address: &str) -> Result<Option<u64>, RelayError> {
        let Some(message) = &self.message else {
            return Ok(None);
        };

        let Some(rate_limits) = message
            .rate_limits
            .as_ref()
            .filter(|limits| !limits.is_empty())
        else {
            return Ok(None);
        };

        if message
            .ip_whitelist
            .as_ref()
            .is_some_and(|whitelist| whitelist.iter().any(|entry| entry == address))
        {
            return Ok(None);
        }

        for window in rate_limits {
            let config = RateLimitConfig::from(window);
            let key = format!("{address}:message:{}", config.period_ms);

            if self.limiter.hit(&key, 1, &config)? {
                return Ok(Some(backoff_ms(&config)));
            }
        }

        Ok(None)
    }

    /// `limits.event.rateLimits` (`event-message-handler.ts:376-443`):
    /// `<pubkey>:events:<period>` or `<pubkey>:events:<period>:[<kinds>]`, the relay's own
    /// pubkey and both whitelists bypass it, and a window whose `kinds` do not match the
    /// event is skipped.
    pub fn event_backoff(
        &self,
        event: &Event,
        remote_address: &str,
        relay_pubkey: Option<&Pubkey>,
    ) -> Result<Option<u64>, RelayError> {
        let Some(limits) = &self.event else {
            return Ok(None);
        };

        let Some(rate_limits) = limits
            .rate_limits
            .as_ref()
            .filter(|limits| !limits.is_empty())
        else {
            return Ok(None);
        };

        if relay_pubkey.is_some_and(|pubkey| *pubkey == event.pubkey) {
            return Ok(None);
        }

        if let Some(whitelist) = &limits.whitelists {
            if whitelist.pubkeys.as_ref().is_some_and(|pubkeys| {
                pubkeys
                    .iter()
                    .any(|pubkey| pubkey.0 == event.pubkey.to_string())
            }) {
                return Ok(None);
            }

            if whitelist
                .ip_addresses
                .as_ref()
                .is_some_and(|addresses| addresses.iter().any(|address| address == remote_address))
            {
                return Ok(None);
            }
        }

        for window in rate_limits {
            if let Some(kinds) = &window.kinds
                && !kinds
                    .iter()
                    .any(|selector| kind_selector_matches(*selector, event.kind))
            {
                continue;
            }

            let config = RateLimitConfig::from(window);
            let key = match &window.kinds {
                Some(kinds) => format!(
                    "{}:events:{}:{}",
                    event.pubkey,
                    config.period_ms,
                    kind_list(kinds)
                ),
                None => format!("{}:events:{}", event.pubkey, config.period_ms),
            };

            if self.limiter.hit(&key, 1, &config)? {
                return Ok(Some(backoff_ms(&config)));
            }
        }

        Ok(None)
    }

    /// `limits.invite.rateLimits` (`subscribe-message-handler.ts:179-206`): one window per
    /// requester, `<pubkey>:invites:<period>`.
    pub fn invite_limited(&self, pubkey: &Pubkey) -> Result<bool, RelayError> {
        let Some(invite) = &self.invite else {
            return Ok(false);
        };

        let Some(rate_limits) = invite
            .rate_limits
            .as_ref()
            .filter(|limits| !limits.is_empty())
        else {
            return Ok(false);
        };

        for window in rate_limits {
            let config = RateLimitConfig::from(window);
            let key = format!("{pubkey}:invites:{}", config.period_ms);

            if self.limiter.hit(&key, 1, &config)? {
                return Ok(true);
            }
        }

        Ok(false)
    }
}

/// `Math.max(1, Math.ceil(period))`, the NIP-01 backoff the limited frames carry.
pub fn backoff_ms(config: &RateLimitConfig) -> u64 {
    config.period_ms.max(1)
}

/// `isEventKindOrRangeMatch`: a bare kind, or an inclusive `[first, last]` range.
pub fn kind_selector_matches(selector: KindSelector, kind: nostream_core::Kind) -> bool {
    match selector {
        KindSelector::Single(candidate) => candidate == kind,
        KindSelector::Range([first, last]) => kind >= first && kind <= last,
    }
}

/// The capture's `toString(kinds)`: `[1,2]`, or `[[10000,19999],1]` for ranges.
fn kind_list(kinds: &[KindSelector]) -> String {
    let elements: Vec<String> = kinds
        .iter()
        .map(|selector| match selector {
            KindSelector::Single(kind) => kind.0.to_string(),
            KindSelector::Range([first, last]) => format!("[{},{}]", first.0, last.0),
        })
        .collect();

    format!("[{}]", elements.join(","))
}
