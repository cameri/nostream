//! NIP-56: reporting. Mirrors `src/utils/nip56.ts`.

use crate::error::CoreError;
use crate::event::{Event, EventId, Pubkey};

/// The parsed target of a kind-1984 report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub reporter: Pubkey,
    pub reported_pubkey: Option<Pubkey>,
    pub reported_event_id: Option<EventId>,
    pub report_type: String,
    pub actionable: bool,
}

/// Parses a kind-1984 report into its target and type.
///
/// Phase 1 stub — job 005; will parse the `p`/`e` tags and report type; see `src/utils/nip56.ts`.
pub fn parse_report(_event: &Event) -> Result<Report, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::nip56::parse_report",
    })
}
