//! Load-aware PoW difficulty. Mirrors `src/utils/adaptive-pow.ts` and
//! `src/utils/wot-pow-policy.ts`.
//!
//! The capture keeps the event rate in module-level state (`rate`, `lastEventAt`) because a
//! relay worker has one process; here it is [`AdaptivePowState`], owned by the relay, so a
//! test can drive it with a fixed clock. The arithmetic is the capture's: the EWMA carries a
//! recency-weighted event count, and the difficulty is scaled from the ratio of the observed
//! per-second rate to `targetEventsPerSecond`.

use crate::error::CoreError;

/// The adaptive-difficulty knobs, copied from the settings section of the same name.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AdaptivePowConfig {
    pub enabled: bool,
    pub floor_bits: u32,
    pub ceiling_bits: u32,
    pub target_events_per_second: f64,
    pub period_ms: u64,
}

/// One WoT-distance difficulty reduction (`WotPowThreshold`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WotPowThreshold {
    pub max_distance: u32,
    pub difficulty_factor: f64,
}

/// The in-process EWMA signal and its last event instant (`rate`/`lastEventAt`,
/// `src/utils/adaptive-pow.ts:7-13`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct AdaptivePowState {
    rate: f64,
    last_event_at_ms: f64,
}

impl AdaptivePowState {
    /// Records one accepted event at `now_ms` (`recordEvent`).
    pub fn record_event(&mut self, period_ms: u64, now_ms: u64) {
        let now = now_ms as f64;
        // `Math.max(0, now - lastEventAt)`: with `lastEventAt` at its `0` default the first
        // call sees a huge deltaT, which decays the zero rate to nothing.
        let delta = (now - self.last_event_at_ms).max(0.0);

        self.rate = calculate_ewma(self.rate, delta, period_ms as f64, 1.0);
        self.last_event_at_ms = now;
    }

    /// The recency-weighted event count (`getCurrentRate`).
    pub fn current_rate(&self) -> f64 {
        self.rate
    }

    /// The rate as events per second (`getCurrentEventsPerSecond`).
    pub fn current_events_per_second(&self, period_ms: u64) -> f64 {
        self.rate / (period_ms as f64 / 1000.0 / std::f64::consts::LN_2)
    }
}

/// `R' = R·e^(−ln2/period·Δt) + step` (`calculateEWMA`, `src/utils/ewma-rate-limiter.ts:32-40`).
pub fn calculate_ewma(rate: f64, delta_t: f64, period: f64, step: f64) -> f64 {
    let lambda = std::f64::consts::LN_2 / period;

    rate * (-lambda * delta_t).exp() + step
}

/// The difficulty the observed rate requires (`getCurrentDifficulty`).
pub fn compute_difficulty(
    config: &AdaptivePowConfig,
    observed_events_per_second: f64,
) -> Result<u32, CoreError> {
    if observed_events_per_second.is_nan() {
        return Err(CoreError::InvalidMessage(
            "adaptive pow: the event rate is not a number".to_owned(),
        ));
    }

    if config.target_events_per_second <= 0.0
        || observed_events_per_second <= config.target_events_per_second
    {
        return Ok(config.floor_bits);
    }

    let ratio = observed_events_per_second / config.target_events_per_second;
    let span = f64::from(config.ceiling_bits.saturating_sub(config.floor_bits));
    let scaled = f64::from(config.floor_bits) + ((ratio - 1.0) * span).ceil();

    let bounded = scaled
        .max(f64::from(config.floor_bits))
        .min(f64::from(config.ceiling_bits));

    Ok(bounded as u32)
}

/// Applies the WoT reduction (`applyWotPowPolicy`): a pubkey outside the trust graph, or
/// with no eligible threshold, pays the computed difficulty in full; the closest eligible
/// threshold wins.
pub fn apply_wot_pow_policy(
    computed_difficulty: u32,
    distance: Option<u32>,
    thresholds: Option<&[WotPowThreshold]>,
) -> u32 {
    let Some(thresholds) = thresholds.filter(|thresholds| !thresholds.is_empty()) else {
        return computed_difficulty;
    };

    let Some(distance) = distance else {
        return computed_difficulty;
    };

    let closest = thresholds
        .iter()
        .filter(|threshold| distance <= threshold.max_distance)
        .min_by_key(|threshold| threshold.max_distance);

    match closest {
        Some(threshold) => {
            let scaled = f64::from(computed_difficulty) * threshold.difficulty_factor;

            scaled.ceil() as u32
        }
        None => computed_difficulty,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    const CONFIG: AdaptivePowConfig = AdaptivePowConfig {
        enabled: true,
        floor_bits: 0,
        ceiling_bits: 24,
        target_events_per_second: 50.0,
        period_ms: 60_000,
    };

    #[test]
    fn a_rate_at_or_below_target_keeps_the_floor() {
        assert_eq!(compute_difficulty(&CONFIG, 0.0).unwrap(), 0);
        assert_eq!(compute_difficulty(&CONFIG, 50.0).unwrap(), 0);
    }

    #[test]
    fn the_ratio_scales_between_the_floor_and_the_ceiling() {
        // 100/s is 2x the target: 0 + ceil(1 * 24) = 24.
        assert_eq!(compute_difficulty(&CONFIG, 100.0).unwrap(), 24);
        // 75/s is 1.5x: ceil(0.5 * 24) = 12.
        assert_eq!(compute_difficulty(&CONFIG, 75.0).unwrap(), 12);
        // Far above the target saturates at the ceiling.
        assert_eq!(compute_difficulty(&CONFIG, 1_000_000.0).unwrap(), 24);
    }

    #[test]
    fn a_zero_target_never_scales() {
        let config = AdaptivePowConfig {
            target_events_per_second: 0.0,
            floor_bits: 3,
            ..CONFIG
        };

        assert_eq!(compute_difficulty(&config, 1_000_000.0).unwrap(), 3);
    }

    #[test]
    fn the_sample_decays_towards_the_target_when_events_stop() {
        let mut state = AdaptivePowState::default();

        for second in 0..100 {
            state.record_event(60_000, second * 1_000);
        }

        // The EWMA approaches one event per second from below: the steady state is 1.0 and
        // the sample is still catching up after 100 half-lives of a second each.
        let busy = state.current_events_per_second(60_000);
        assert!((0.5..1.0).contains(&busy), "{busy}");

        // Ten half-lives with no events leave a tenth of the sample.
        state.record_event(60_000, 100_000 + 600_000);
        let idle = state.current_events_per_second(60_000);
        assert!(idle < busy / 10.0, "{idle} after {busy}");
    }

    #[test]
    fn the_wot_policy_takes_the_closest_eligible_threshold() {
        let thresholds = [
            WotPowThreshold {
                max_distance: 1,
                difficulty_factor: 0.0,
            },
            WotPowThreshold {
                max_distance: 2,
                difficulty_factor: 0.5,
            },
        ];

        assert_eq!(apply_wot_pow_policy(10, Some(1), Some(&thresholds)), 0);
        assert_eq!(apply_wot_pow_policy(10, Some(2), Some(&thresholds)), 5);
        assert_eq!(apply_wot_pow_policy(10, Some(3), Some(&thresholds)), 10);
        assert_eq!(apply_wot_pow_policy(10, None, Some(&thresholds)), 10);
        assert_eq!(apply_wot_pow_policy(10, Some(1), None), 10);
        assert_eq!(apply_wot_pow_policy(9, Some(2), Some(&thresholds)), 5);
    }
}
