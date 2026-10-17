//! The event strategies. Mirrors `src/handlers/event-strategies/*-event-strategy.ts` at the
//! capture commit: 15 strategies, one module each.

pub mod contact_list;
pub mod default;
pub mod delete;
pub mod dvm_job_request;
pub mod ephemeral;
pub mod gift_wrap;
pub mod group;
pub mod invite_request;
pub mod join_request;
pub mod leave_request;
pub mod parameterized_replaceable;
pub mod replaceable;
pub mod report;
pub mod timestamp;
pub mod vanish;

use nostream_core::Event;

use crate::error::RelayError;

/// What a strategy decided about one event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StrategyOutcome {
    Accept,
    Reject(String),
}

/// Dispatches an event to its strategy.
///
/// Phase 1 stub — job 005; will pick the strategy for the kind and run it; see `src/factories/event-strategy-factory.ts`.
pub async fn dispatch(_event: &Event) -> Result<StrategyOutcome, RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::strategies::dispatch",
    })
}
