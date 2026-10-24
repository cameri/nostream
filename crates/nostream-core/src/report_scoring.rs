//! NIP-56 report scoring. Mirrors `src/utils/report-scoring.ts`.
//!
//! A trusted moderator's report always carries maximum weight, independent of their distance
//! in the web-of-trust graph; everyone else decays by hop: a direct follow (distance 1) gets
//! full weight, each further hop halves it, and a pubkey outside the graph gets zero — stored,
//! but "doesn't trigger anything".

/// The weight a report carries, derived from the reporter's WoT distance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportWeight {
    /// A trusted moderator's report: maximum weight and actionable.
    Trusted,
    /// A report from a known pubkey at the given distance.
    Weighted { distance: u32 },
    /// A report from outside the trust graph: stored, never actionable.
    Unweighted,
}

impl ReportWeight {
    /// The weight the `reports.weight` column's `real` holds (`calculateReportWeight`,
    /// `src/utils/report-scoring.ts:8-16`).
    pub fn weight(self) -> f32 {
        match self {
            Self::Trusted => 1.0,
            Self::Unweighted => 0.0,
            // `2 ** -(distance - 1)`, and `distance <= 1` is the flat full weight.
            Self::Weighted { distance } => {
                let hops = distance.saturating_sub(1);

                // f32's smallest subnormal is 2^-149, so 2^-150 is the first exponent that
                // lands on zero (Assumption 7 of the job's spec).
                if hops >= 150 {
                    0.0
                } else {
                    2f32.powi(-(hops as i32))
                }
            }
        }
    }
}

/// Scores a reporter against the relay's trust graph (`calculateReportWeight`).
pub fn score_reporter(distance: Option<u32>, is_trusted_moderator: bool) -> ReportWeight {
    if is_trusted_moderator {
        return ReportWeight::Trusted;
    }

    match distance {
        None => ReportWeight::Unweighted,
        Some(distance) => ReportWeight::Weighted { distance },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trusted_moderator_is_trusted_whatever_the_distance() {
        assert_eq!(score_reporter(None, true), ReportWeight::Trusted);
        assert_eq!(score_reporter(Some(7), true), ReportWeight::Trusted);
        assert_eq!(ReportWeight::Trusted.weight(), 1.0);
    }

    #[test]
    fn no_distance_is_unweighted() {
        assert_eq!(score_reporter(None, false), ReportWeight::Unweighted);
        assert_eq!(ReportWeight::Unweighted.weight(), 0.0);
    }

    #[test]
    fn a_direct_follow_weighs_one() {
        assert_eq!(
            score_reporter(Some(1), false),
            ReportWeight::Weighted { distance: 1 }
        );
        assert_eq!(score_reporter(Some(0), false).weight(), 1.0);
        assert_eq!(score_reporter(Some(1), false).weight(), 1.0);
    }

    #[test]
    fn each_further_hop_halves_the_weight() {
        let weights: Vec<f32> = (2..=5)
            .map(|distance| score_reporter(Some(distance), false).weight())
            .collect();

        assert_eq!(weights, vec![0.5, 0.25, 0.125, 0.0625]);
    }

    #[test]
    fn a_very_large_distance_underflows_to_zero() {
        assert_eq!(score_reporter(Some(150), false).weight(), 0.0);
        assert_eq!(score_reporter(Some(u32::MAX), false).weight(), 0.0);
    }
}
