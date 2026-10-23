//! The rate limiters: the window math, its asymmetries, the four wiring levels, whitelists
//! and the fail-closed paths. Carries `test/unit/utils/sliding-window-rate-limiter.spec.ts`
//! (3 cases), `test/unit/utils/ewma-rate-limiter.spec.ts` (6), and the behaviour of
//! `src/handlers/request-handlers/rate-limiter-middleware.ts`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::float_cmp
)]

mod common;

use std::sync::Arc;

use common::{CLIENT_SECRET, NOW_MS, NOW_SECS, relay_keys, signed_event};
use nostream_config::settings::{
    ConnectionLimits, EventLimits, EventRateLimit, InviteLimits, Limits, MessageLimits,
    MessageRateLimit, RateLimit, RateLimiterStrategy, Settings,
};
use nostream_core::clock::{Clock, TestClock};
use nostream_core::{Event, Kind, KindSelector, Pubkey};
use nostream_relay::limits::{
    EwmaRateLimiter, Limiter, MAX_STORE_KEYS, RateLimitConfig, RateLimits,
    SlidingWindowRateLimiter, backoff_ms, kind_selector_matches,
};
use nostream_relay::testing::{FailingLimiter, Fixture, settings};

/// A sliding-window limiter over a clock the test moves.
fn sliding(start_ms: u64) -> (Arc<TestClock>, SlidingWindowRateLimiter) {
    let clock = Arc::new(TestClock::new(start_ms));

    (
        Arc::clone(&clock),
        SlidingWindowRateLimiter::new(Arc::clone(&clock) as Arc<dyn Clock>),
    )
}

fn ewma(start_ms: u64) -> (Arc<TestClock>, EwmaRateLimiter) {
    let clock = Arc::new(TestClock::new(start_ms));

    (
        Arc::clone(&clock),
        EwmaRateLimiter::new(Arc::clone(&clock) as Arc<dyn Clock>),
    )
}

/// A realistic start instant: with a clock at zero, a hit's score equals `now - period`
/// and the script's inclusive removal would drop it, which never happens with wall time.
const BASE: u64 = NOW_MS;

const WINDOW: RateLimitConfig = RateLimitConfig {
    period_ms: 60_000,
    rate: 3,
};

/// `hit`, unwrapped: the in-process store cannot fail in these tests.
fn hit(limiter: &impl Limiter, key: &str, step: u64, config: &RateLimitConfig) -> bool {
    limiter
        .hit(key, step, config)
        .expect("the in-process store")
}

// ---------------------------------------------------------------------------------------
// Sliding window (R21)
// ---------------------------------------------------------------------------------------

#[test]
fn the_sliding_window_allows_up_to_the_rate_and_refuses_the_next() {
    let (_clock, limiter) = sliding(BASE);

    for _ in 0..3 {
        assert!(!hit(&limiter, "k", 1, &WINDOW));
    }

    assert!(hit(&limiter, "k", 1, &WINDOW));
}

#[test]
fn sum_plus_step_equal_to_the_rate_is_allowed() {
    let (_clock, limiter) = sliding(BASE);

    // step 3 in one hit against a rate of 3: 0 + 3 == 3 is allowed.
    assert!(!hit(&limiter, "k", 3, &WINDOW));
    assert!(hit(&limiter, "k", 1, &WINDOW));
}

#[test]
fn a_refused_sliding_hit_is_not_recorded() {
    let (_clock, limiter) = sliding(BASE);
    let config = RateLimitConfig {
        period_ms: 60_000,
        rate: 1,
    };

    assert!(!hit(&limiter, "k", 1, &config));
    assert!(hit(&limiter, "k", 1, &config));
    assert_eq!(limiter.len("k"), 1, "the refused hit left no entry");
}

#[test]
fn the_sliding_window_boundary_is_inclusive_on_removal() {
    let config = RateLimitConfig {
        period_ms: 60_000,
        rate: 1,
    };

    let (clock, limiter) = sliding(BASE);
    assert!(!hit(&limiter, "k", 1, &config));

    // Exactly one period later the entry's score equals `now - period` and is dropped.
    clock.set(BASE + 60_000);
    assert_eq!(limiter.len("k"), 1, "the entry has not been swept yet");
    assert!(!hit(&limiter, "k", 1, &config));

    // One millisecond earlier the first entry still counts.
    let (clock, limiter) = sliding(BASE);
    assert!(!hit(&limiter, "k", 1, &config));
    clock.set(BASE + 59_999);
    assert!(hit(&limiter, "k", 1, &config));

    // Two periods later the last entry is outside the window again.
    clock.set(BASE + 120_000);
    assert!(!hit(&limiter, "k", 1, &config));
}

#[test]
fn keys_are_independent() {
    let (_clock, limiter) = sliding(BASE);
    let config = RateLimitConfig {
        period_ms: 60_000,
        rate: 1,
    };

    assert!(!hit(&limiter, "a", 1, &config));
    assert!(!hit(&limiter, "b", 1, &config));
    assert!(hit(&limiter, "a", 1, &config));
}

// ---------------------------------------------------------------------------------------
// EWMA (R21)
// ---------------------------------------------------------------------------------------

#[test]
fn the_ewma_decays_by_half_each_period() {
    // period 1500 ms: the entry's TTL is 2000 ms, so a hit exactly one half-life later
    // still finds the stored rate (a whole-second period would have expired it).
    let (clock, limiter) = ewma(BASE);
    let config = RateLimitConfig {
        period_ms: 1_500,
        rate: 100,
    };

    assert!(!hit(&limiter, "k", 1, &config));
    let first = limiter.rate("k", &config).expect("a stored rate");
    assert!((first - 1.0).abs() < 1e-9, "{first}");

    // One half-life later an old rate of 1 decays to 0.5, plus the new step.
    clock.advance(1_500);
    assert!(!hit(&limiter, "k", 1, &config));
    let second = limiter.rate("k", &config).expect("a stored rate");
    assert!((second - 1.5).abs() < 1e-9, "{second}");
}

#[test]
fn a_limited_ewma_hit_is_still_recorded() {
    let (clock, limiter) = ewma(BASE);
    let config = RateLimitConfig {
        period_ms: 1_500,
        rate: 1,
    };

    // 1.0 is not > 1, so the first hit is allowed.
    assert!(!hit(&limiter, "k", 1, &config));
    // 1.0 + 1 = 2.0 > 1: limited, and stored.
    assert!(hit(&limiter, "k", 1, &config));
    assert!(
        limiter
            .rate("k", &config)
            .is_some_and(|rate| (rate - 2.0).abs() < 1e-9)
    );

    // The stored rate halves over a half-life; the next hit adds 1 and is limited again.
    clock.advance(1_500);
    assert!(hit(&limiter, "k", 1, &config));
}

#[test]
fn an_ewma_key_expires_after_its_ceil_ttl() {
    // period 1500 ms -> ceil(1500 / 1000) * 1000 = 2000 ms TTL.
    let (clock, limiter) = ewma(BASE);
    let config = RateLimitConfig {
        period_ms: 1_500,
        rate: 1,
    };

    assert!(!hit(&limiter, "k", 1, &config));
    assert!(hit(&limiter, "k", 1, &config));

    // At the TTL the entry is gone: the next hit starts from zero.
    clock.set(BASE + 2_000);
    assert_eq!(limiter.rate("k", &config), None);

    assert!(!hit(&limiter, "k", 1, &config));
    let rate = limiter.rate("k", &config).expect("a stored rate");
    assert!((rate - 1.0).abs() < 1e-9, "{rate}");
}

#[test]
fn a_fresh_ewma_key_starts_from_zero_at_now() {
    let (clock, limiter) = ewma(1_000_000);
    let config = RateLimitConfig {
        period_ms: 60_000,
        rate: 5,
    };

    assert!(!hit(&limiter, "fresh", 2, &config));
    let rate = limiter.rate("fresh", &config).expect("a stored rate");
    assert!((rate - 2.0).abs() < 1e-9, "{rate}");
    assert_eq!(clock.now_ms(), 1_000_000);
}

// ---------------------------------------------------------------------------------------
// Reclamation (R20's TTL, in memory and not only in the verdict)
// ---------------------------------------------------------------------------------------

#[test]
fn an_expired_sliding_key_is_reclaimed_instead_of_kept_for_the_process_lifetime() {
    let (clock, limiter) = sliding(BASE);
    let config = RateLimitConfig {
        period_ms: 1_000,
        rate: 3,
    };

    for index in 0..100 {
        assert!(!hit(&limiter, &format!("k{index}"), 1, &config));
    }
    assert_eq!(limiter.key_count(), 100);

    // Every key is now a whole window old: the next hit sweeps them, as Redis would have
    // expired them, and only the key it touched remains.
    clock.advance(config.period_ms);
    assert!(!hit(&limiter, "fresh", 1, &config));
    assert_eq!(limiter.key_count(), 1);
}

#[test]
fn an_expired_ewma_key_is_reclaimed_instead_of_kept_for_the_process_lifetime() {
    let (clock, limiter) = ewma(BASE);
    let config = RateLimitConfig {
        period_ms: 1_000,
        rate: 3,
    };

    for index in 0..100 {
        assert!(!hit(&limiter, &format!("k{index}"), 1, &config));
    }
    assert_eq!(limiter.key_count(), 100);

    clock.advance(config.period_ms);
    assert!(!hit(&limiter, "fresh", 1, &config));
    assert_eq!(limiter.key_count(), 1);
}

#[test]
fn a_flood_of_new_keys_never_grows_a_store_past_its_ceiling() {
    let (_, limiter) = sliding(BASE);
    let config = RateLimitConfig {
        period_ms: 60_000,
        rate: 3,
    };

    for index in 0..(MAX_STORE_KEYS + 1_000) {
        assert!(!hit(&limiter, &format!("k{index}"), 1, &config));
    }

    assert_eq!(limiter.key_count(), MAX_STORE_KEYS);
}

#[test]
fn a_reclaimed_key_starts_a_fresh_window_rather_than_a_stale_one() {
    let (clock, limiter) = sliding(BASE);
    let config = RateLimitConfig {
        period_ms: 1_000,
        rate: 1,
    };

    assert!(!hit(&limiter, "k", 1, &config));
    assert!(hit(&limiter, "k", 1, &config));

    clock.advance(config.period_ms);
    assert!(!hit(&limiter, "other", 1, &config));
    assert_eq!(limiter.key_count(), 1, "the stale key was swept");
    assert!(
        !hit(&limiter, "k", 1, &config),
        "a fresh window allows again"
    );
}

// ---------------------------------------------------------------------------------------
// AC30: the model-based property test
// ---------------------------------------------------------------------------------------

/// A tiny deterministic generator, so the property test needs no new dependency and its
/// failures are reproducible from the sequence number.
struct Generator {
    state: u64,
}

impl Generator {
    fn new(seed: u64) -> Self {
        Self {
            state: seed ^ 0x9e37_79b9_7f4a_7c15,
        }
    }

    fn next(&mut self) -> u64 {
        // SplitMix64.
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);

        z ^ (z >> 31)
    }

    fn below(&mut self, bound: u64) -> u64 {
        if bound == 0 { 0 } else { self.next() % bound }
    }
}

/// The sliding-window script, re-expressed independently: one sorted set per key, entries
/// with their score and step, `ZREMRANGEBYSCORE 0 windowStart`, sum, then record only when
/// allowed. The script also sets `PEXPIRE key period` on every write, so a key that has not
/// been written for a whole window is gone before the next `ZREMRANGEBYSCORE` runs.
#[derive(Default)]
struct SlidingModel {
    entries: std::collections::BTreeMap<String, (u64, Vec<(u64, u64)>)>,
}

impl SlidingModel {
    fn hit(&mut self, key: &str, now: u64, step: u64, config: &RateLimitConfig) -> bool {
        let window_start = now.saturating_sub(config.period_ms);
        let (stored_period, mut entries) = self
            .entries
            .remove(key)
            .unwrap_or((config.period_ms, Vec::new()));

        // `PEXPIRE` set the key's window at its last write: once every hit is older than
        // that, the key is gone and the next hit starts from an empty set.
        if entries
            .iter()
            .all(|(at, _)| now.saturating_sub(*at) >= stored_period)
        {
            entries.clear();
        }

        entries.retain(|(at, _)| *at > window_start);

        let sum: u64 = entries.iter().map(|(_, step)| *step).sum();
        let limited = sum.saturating_add(step) > config.rate;

        let period_ms = if limited {
            stored_period
        } else {
            entries.push((now, step));
            config.period_ms
        };

        self.entries.insert(key.to_owned(), (period_ms, entries));

        limited
    }
}

/// The EWMA script, re-expressed independently: decay, store, then compare. The state
/// carries the `EXPIRE` its last write set (`ceil(period / 1000)` s), so a key that has not
/// been written for its whole TTL reads as absent.
struct EwmaModel {
    state: Option<(f64, u64, u64)>,
}

impl EwmaModel {
    fn hit(&mut self, now: u64, step: u64, config: &RateLimitConfig) -> bool {
        let ttl = config.period_ms.div_ceil(1000) * 1000;

        let (old_rate, old_at) = match self.state {
            Some((rate, at, stored_ttl)) if now.saturating_sub(at) < stored_ttl => (rate, at),
            _ => (0.0, now),
        };

        let lambda = std::f64::consts::LN_2 / config.period_ms as f64;
        let rate = old_rate * (-lambda * (now.saturating_sub(old_at)) as f64).exp() + step as f64;

        self.state = Some((rate, now, ttl));

        rate > config.rate as f64
    }
}

fn config_from(generator: &mut Generator) -> RateLimitConfig {
    RateLimitConfig {
        period_ms: [1_000, 1_500, 10_000, 60_000][generator.below(4) as usize],
        rate: 1 + generator.below(5),
    }
}

#[test]
fn ten_thousand_sliding_sequences_agree_with_the_model() {
    let mut disagreements = 0;

    for sequence in 0..10_000u64 {
        let mut generator = Generator::new(sequence);
        let clock = Arc::new(TestClock::new(1_000_000));
        let limiter = SlidingWindowRateLimiter::new(Arc::clone(&clock) as Arc<dyn Clock>);
        let mut model = SlidingModel::default();
        let mut config = config_from(&mut generator);

        for _ in 0..8 {
            let key = ["a", "b"][generator.below(2) as usize];
            let step = 1 + generator.below(3);
            clock.advance(generator.below(config.period_ms * 2));

            let expected = model.hit(key, clock.now_ms(), step, &config);
            let actual = hit(&limiter, key, step, &config);

            if expected != actual {
                disagreements += 1;
            }

            if generator.below(4) == 0 {
                config = config_from(&mut generator);
            }
        }
    }

    assert_eq!(disagreements, 0);
}

#[test]
fn ten_thousand_ewma_sequences_agree_with_the_model() {
    let mut disagreements = 0;

    for sequence in 0..10_000u64 {
        let mut generator = Generator::new(sequence ^ 0x5eed);
        let clock = Arc::new(TestClock::new(1_000_000));
        let limiter = EwmaRateLimiter::new(Arc::clone(&clock) as Arc<dyn Clock>);
        let mut model = EwmaModel { state: None };
        let config = config_from(&mut generator);

        for _ in 0..8 {
            let step = 1 + generator.below(2);
            clock.advance(generator.below(config.period_ms));

            let expected = model.hit(clock.now_ms(), step, &config);
            let actual = hit(&limiter, "k", step, &config);

            if expected != actual {
                disagreements += 1;
            }
        }
    }

    assert_eq!(disagreements, 0);
}

// ---------------------------------------------------------------------------------------
// Wiring, whitelists and selection (R20/R22)
// ---------------------------------------------------------------------------------------

fn limits_from(settings: &Settings, clock: Arc<TestClock>) -> RateLimits {
    RateLimits::new(settings, clock)
}

fn settings_with(limits: Limits) -> Settings {
    let mut settings = settings();
    settings.limits = Some(limits);

    settings
}

#[test]
fn the_strategy_defaults_to_ewma_and_honours_sliding_window() {
    let clock = Arc::new(TestClock::new(BASE));
    let defaults = settings();

    assert_eq!(
        limits_from(&defaults, Arc::clone(&clock)).strategy(),
        RateLimiterStrategy::Ewma
    );

    let sliding_settings = settings_with(Limits {
        rate_limiter: Some(nostream_config::settings::RateLimiterSettings {
            strategy: RateLimiterStrategy::SlidingWindow,
        }),
        ..Default::default()
    });

    assert_eq!(
        limits_from(&sliding_settings, clock).strategy(),
        RateLimiterStrategy::SlidingWindow
    );
}

#[test]
fn the_connection_level_uses_addr_connection_period_and_its_whitelist() {
    let clock = Arc::new(TestClock::new(BASE));
    let settings = settings_with(Limits {
        connection: Some(ConnectionLimits {
            rate_limits: vec![RateLimit {
                description: None,
                period: 1_000,
                rate: 1,
            }],
            ip_whitelist: Some(vec!["10.0.0.1".to_owned()]),
            ip_blacklist: None,
        }),
        ..Default::default()
    });
    let limits = limits_from(&settings, clock);

    assert!(!limits.connection_limited("192.0.2.1").expect("store"));
    assert!(limits.connection_limited("192.0.2.1").expect("store"));
    assert!(!limits.connection_limited("10.0.0.1").expect("store"));
}

#[test]
fn the_message_level_reports_the_period_as_the_backoff() {
    let clock = Arc::new(TestClock::new(BASE));
    let settings = settings_with(Limits {
        message: Some(MessageLimits {
            rate_limits: Some(vec![MessageRateLimit {
                description: None,
                message_type: Some("REQ".to_owned()),
                period: 2_500,
                rate: 1,
            }]),
            ip_whitelist: None,
        }),
        ..Default::default()
    });
    let limits = limits_from(&settings, clock);

    assert_eq!(limits.message_backoff("192.0.2.1").expect("store"), None);
    assert_eq!(
        limits.message_backoff("192.0.2.1").expect("store"),
        Some(2_500)
    );
    assert_eq!(
        backoff_ms(&RateLimitConfig {
            period_ms: 2_500,
            rate: 1
        }),
        2_500
    );
    assert_eq!(
        backoff_ms(&RateLimitConfig {
            period_ms: 0,
            rate: 1
        }),
        1,
        "Math.max(1, ceil(period))"
    );
}

#[test]
fn the_message_level_with_no_windows_never_limits() {
    let clock = Arc::new(TestClock::new(BASE));
    let settings = settings_with(Limits {
        message: Some(MessageLimits {
            rate_limits: Some(Vec::new()),
            ip_whitelist: None,
        }),
        ..Default::default()
    });

    assert_eq!(
        limits_from(&settings, clock)
            .message_backoff("192.0.2.1")
            .expect("store"),
        None
    );
}

fn event_at(kind: u64, pubkey: Pubkey) -> Event {
    use nostream_core::event::{EventId, Signature};

    Event {
        id: EventId::from_byte_array([1; 32]),
        pubkey,
        created_at: NOW_SECS,
        kind: Kind(kind),
        tags: Vec::new(),
        content: String::new(),
        sig: Signature::from_byte_array([0; 64]),
    }
}

#[test]
fn the_event_level_keys_by_pubkey_period_and_kinds_and_skips_other_kinds() {
    let clock = Arc::new(TestClock::new(BASE));
    let pubkey = nostream_core::crypto::public_key(&CLIENT_SECRET).expect("pubkey");
    let settings = settings_with(Limits {
        event: Some(EventLimits {
            rate_limits: Some(vec![EventRateLimit {
                description: None,
                kinds: Some(vec![KindSelector::Range([Kind(1), Kind(2)])]),
                period: 60_000,
                rate: 1,
            }]),
            ..Default::default()
        }),
        ..Default::default()
    });
    let limits = limits_from(&settings, clock);

    let other = event_at(3, pubkey);
    assert_eq!(
        limits
            .event_backoff(&other, "192.0.2.1", None)
            .expect("store"),
        None
    );

    let matching = event_at(1, pubkey);
    assert_eq!(
        limits
            .event_backoff(&matching, "192.0.2.1", None)
            .expect("store"),
        None
    );
    assert_eq!(
        limits
            .event_backoff(&matching, "192.0.2.1", None)
            .expect("store"),
        Some(60_000)
    );
    assert!(kind_selector_matches(
        KindSelector::Single(Kind(4)),
        Kind(4)
    ));
    assert!(!kind_selector_matches(
        KindSelector::Single(Kind(4)),
        Kind(5)
    ));
}

#[test]
fn the_event_level_bypasses_the_relay_pubkey_and_both_whitelists() {
    let clock = Arc::new(TestClock::new(BASE));
    let pubkey = nostream_core::crypto::public_key(&CLIENT_SECRET).expect("pubkey");
    let settings = settings_with(Limits {
        event: Some(EventLimits {
            rate_limits: Some(vec![EventRateLimit {
                description: None,
                kinds: None,
                period: 60_000,
                rate: 1,
            }]),
            whitelists: Some(nostream_config::settings::EventWhitelists {
                pubkeys: Some(vec![nostream_core::SettingsPubkey(pubkey.to_string())]),
                ip_addresses: Some(vec!["10.0.0.1".to_owned()]),
            }),
            ..Default::default()
        }),
        ..Default::default()
    });
    let limits = limits_from(&settings, Arc::clone(&clock));
    let event = event_at(1, pubkey);

    // The pubkey and the address whitelist each bypass.
    assert_eq!(
        limits
            .event_backoff(&event, "192.0.2.1", None)
            .expect("store"),
        None
    );
    assert_eq!(
        limits
            .event_backoff(&event, "10.0.0.1", None)
            .expect("store"),
        None
    );

    let plain = settings_with(Limits {
        event: Some(EventLimits {
            rate_limits: Some(vec![EventRateLimit {
                description: None,
                kinds: None,
                period: 60_000,
                rate: 1,
            }]),
            ..Default::default()
        }),
        ..Default::default()
    });
    let limits = limits_from(&plain, Arc::new(TestClock::new(BASE)));

    // The relay's own key bypasses even without a whitelist.
    assert_eq!(
        limits
            .event_backoff(&event, "192.0.2.1", Some(&pubkey))
            .expect("store"),
        None
    );
    assert_eq!(
        limits
            .event_backoff(&event, "192.0.2.1", None)
            .expect("store"),
        None
    );
    assert_eq!(
        limits
            .event_backoff(&event, "192.0.2.1", None)
            .expect("store"),
        Some(60_000)
    );
}

#[test]
fn the_invite_level_is_scoped_per_pubkey() {
    let clock = Arc::new(TestClock::new(BASE));
    let pubkey = nostream_core::crypto::public_key(&CLIENT_SECRET).expect("pubkey");
    let other = nostream_core::crypto::public_key(&[9u8; 32]).expect("pubkey");
    let settings = settings_with(Limits {
        invite: Some(InviteLimits {
            rate_limits: Some(vec![RateLimit {
                description: None,
                period: 60_000,
                rate: 1,
            }]),
        }),
        ..Default::default()
    });
    let limits = limits_from(&settings, clock);

    assert!(!limits.invite_limited(&pubkey).expect("store"));
    assert!(limits.invite_limited(&pubkey).expect("store"));
    assert!(!limits.invite_limited(&other).expect("store"));
}

#[test]
fn a_failing_store_reports_an_error_at_every_level() {
    let settings = settings_with(Limits {
        connection: Some(ConnectionLimits {
            rate_limits: vec![RateLimit {
                description: None,
                period: 1_000,
                rate: 1,
            }],
            ip_whitelist: None,
            ip_blacklist: None,
        }),
        message: Some(MessageLimits {
            rate_limits: Some(vec![MessageRateLimit {
                description: None,
                message_type: None,
                period: 1_000,
                rate: 1,
            }]),
            ip_whitelist: None,
        }),
        event: Some(EventLimits {
            rate_limits: Some(vec![EventRateLimit {
                description: None,
                kinds: None,
                period: 1_000,
                rate: 1,
            }]),
            ..Default::default()
        }),
        invite: Some(InviteLimits {
            rate_limits: Some(vec![RateLimit {
                description: None,
                period: 1_000,
                rate: 1,
            }]),
        }),
        ..Default::default()
    });
    let limits = RateLimits::with_limiter(Arc::new(FailingLimiter), &settings);
    let pubkey = nostream_core::crypto::public_key(&CLIENT_SECRET).expect("pubkey");

    assert!(limits.connection_limited("192.0.2.1").is_err());
    assert!(limits.message_backoff("192.0.2.1").is_err());
    assert!(
        limits
            .event_backoff(&event_at(1, pubkey), "192.0.2.1", None)
            .is_err()
    );
    assert!(limits.invite_limited(&pubkey).is_err());
}

#[tokio::test]
async fn a_failing_event_limiter_limits_the_event_without_a_backoff() {
    let fixture = Fixture::new(settings_with(Limits {
        event: Some(EventLimits {
            rate_limits: Some(vec![EventRateLimit {
                description: None,
                kinds: None,
                period: 60_000,
                rate: 1,
            }]),
            ..Default::default()
        }),
        ..Default::default()
    }));

    let (sink, mut frames) = nostream_relay::sink::FrameSink::channel();
    let clock = Arc::new(TestClock::new(NOW_MS));
    let connection = Arc::new(nostream_relay::connection::Connection::new(
        "127.0.0.1".to_owned(),
        nostream_core::nip42::Nip42Session::with_challenge("challenge", 0),
    ));
    let limits = Arc::new(RateLimits::with_limiter(
        Arc::new(FailingLimiter),
        &fixture.settings,
    ));
    let context = fixture.context_with_limits(clock, relay_keys(), connection, sink, limits);

    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);
    nostream_relay::handlers::event::handle(event.clone(), &context).await;

    let frame = frames.recv().await.expect("a frame");

    assert_eq!(
        frame,
        format!(r#"["OK","{}",false,"rate-limited: slow down"]"#, event.id),
        "fail closed, with no backoff to promise"
    );
}

#[test]
fn the_limiter_trait_exposes_the_selected_store() {
    let clock = Arc::new(TestClock::new(BASE));
    let defaults = settings();
    let limiter = nostream_relay::limits::RateLimiter::from_settings(&defaults, clock);

    assert_eq!(limiter.strategy(), RateLimiterStrategy::Ewma);
    assert!(!hit(
        &limiter,
        "k",
        1,
        &RateLimitConfig {
            period_ms: 1,
            rate: 1
        }
    ));
}
