//! The `created_at` window the relay accepts.
//!
//! Mirrors `src/handlers/event-message-handler.ts:179,203-218` (and its twin in
//! `src/app/static-mirroring-worker.ts:203-219`). The reference time is an argument, never a
//! clock read: the capture reads `Date.now()` inside the check because it has no such seam,
//! and [`crate::clock::Clock`] is where the rewrite reads time.

use crate::error::CoreError;

/// Checks `created_at` against the reference time
/// (`src/handlers/event-message-handler.ts:203-217`).
///
/// A delta applies only when it is defined and greater than zero; with either delta
/// absent or zero, that direction is unchecked. The bounds are inclusive: `created_at`
/// exactly `now + delta` or `now - delta` passes.
pub fn check_created_at(
    created_at: i64,
    now: i64,
    max_positive_delta: Option<i64>,
    max_negative_delta: Option<i64>,
) -> Result<(), CoreError> {
    if let Some(delta) = max_positive_delta.filter(|delta| *delta > 0)
        && created_at > now.saturating_add(delta)
    {
        return Err(CoreError::CreatedAtInFuture { delta });
    }

    if let Some(delta) = max_negative_delta.filter(|delta| *delta > 0)
        && created_at < now.saturating_sub(delta)
    {
        return Err(CoreError::CreatedAtInPast { delta });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    const NOW: i64 = 1_700_000_000;

    #[test]
    fn created_at_inside_the_window_passes() {
        assert!(check_created_at(NOW, NOW, Some(900), Some(86_400)).is_ok());
    }

    #[test]
    fn created_at_at_the_future_bound_passes() {
        assert!(check_created_at(NOW + 900, NOW, Some(900), None).is_ok());
    }

    #[test]
    fn created_at_one_past_the_future_bound_is_rejected() {
        let error = check_created_at(NOW + 901, NOW, Some(900), None).unwrap_err();

        assert_eq!(
            error.to_string(),
            "rejected: created_at is more than 900 seconds in the future"
        );
        assert!(matches!(error, CoreError::CreatedAtInFuture { delta: 900 }));
    }

    #[test]
    fn created_at_at_the_past_bound_passes() {
        assert!(check_created_at(NOW - 900, NOW, None, Some(900)).is_ok());
    }

    #[test]
    fn created_at_one_past_the_past_bound_is_rejected() {
        let error = check_created_at(NOW - 901, NOW, None, Some(900)).unwrap_err();

        assert_eq!(
            error.to_string(),
            "rejected: created_at is more than 900 seconds in the past"
        );
        assert!(matches!(error, CoreError::CreatedAtInPast { delta: 900 }));
    }

    #[test]
    fn created_at_delta_applies_only_when_positive() {
        assert!(check_created_at(NOW + 10_000, NOW, Some(0), None).is_ok());
        assert!(check_created_at(NOW - 10_000, NOW, None, Some(0)).is_ok());
        assert!(check_created_at(NOW + 10_000, NOW, Some(-5), None).is_ok());
        assert!(check_created_at(NOW - 10_000, NOW, None, Some(-5)).is_ok());
        assert!(check_created_at(NOW + 10_000, NOW, None, None).is_ok());
    }

    #[test]
    fn created_at_future_is_checked_before_past() {
        let error = check_created_at(NOW + 901, NOW, Some(900), Some(900)).unwrap_err();

        assert!(matches!(error, CoreError::CreatedAtInFuture { .. }));
    }
}
