//! NIP-56 report scoring. Mirrors `src/utils/report-scoring.ts`.

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

/// Scores a reporter against the relay's trust graph.
///
/// Phase 1 stub — job 005; will score a kind-1984 report by WoT distance; see `src/utils/report-scoring.ts`.
pub fn score_reporter(
    _distance: Option<u32>,
    _is_trusted_moderator: bool,
) -> Result<ReportWeight, crate::error::CoreError> {
    Err(crate::error::CoreError::NotImplemented {
        module: "core::report_scoring::score_reporter",
    })
}
