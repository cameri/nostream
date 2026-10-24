//! The event strategies. Mirrors `src/handlers/event-strategies/*-event-strategy.ts` and the
//! selection chain of `src/factories/event-strategy-factory.ts:56-108`.
//!
//! A strategy is one type implementing [`EventStrategy`] — `IEventStrategy.execute`'s one
//! method, `(event, context)` — and every arm has that shape, so behaviour is added to a type
//! rather than a second convention chosen (ADR 0004 records the signature, which departs from
//! the capture's `(event, sink)`). [`select`] picks the arm in the capture's order, which
//! **is** the policy, and [`Strategy`] runs it. All fifteen arms are implemented here.

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

use std::future::Future;
use std::pin::Pin;

use nostream_core::{Event, Kind, expiration};
use nostream_storage::repositories::EventRecord;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::default::DefaultStrategy;

/// One strategy's outcome (`IEventStrategy.execute`).
///
/// `execute` writes its own frames through the context's sink, exactly as the capture's
/// strategies emit `OK`/`EVENT` messages; an `Err` is the handler's
/// `error: unable to process event`.
pub trait EventStrategy: Send + Sync {
    /// Runs the strategy for `event`.
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>>;
}

/// Which arm `eventStrategyFactory` selects, in its order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Selection {
    Vanish,
    GiftWrap,
    Group,
    Timestamp,
    ContactList,
    Report,
    Replaceable,
    Join,
    Leave,
    InviteRequest,
    DvmJob,
    Ephemeral,
    Delete,
    ParameterizedReplaceable,
    Default,
}

/// The capture's selection chain (`eventStrategyFactory`, `:56-108`).
///
/// The order is the policy: contact lists are intercepted before the generic replaceable
/// arm, reports before the default arm, and the NIP-43 requests before the ephemeral arm
/// (kinds 28934/28935/28936 fall in the ephemeral range and must not be broadcast).
pub fn select(event: &Event) -> Selection {
    if event.is_request_to_vanish(None) {
        Selection::Vanish
    } else if event.kind.is_gift_wrap() {
        Selection::GiftWrap
    } else if event.kind.is_marmot_group_event() {
        Selection::Group
    } else if event.kind == Kind(1040) {
        Selection::Timestamp
    } else if event.kind.is_contact_list() {
        Selection::ContactList
    } else if event.kind == Kind::REPORT {
        Selection::Report
    } else if event.kind == Kind(10_002) || event.kind.is_replaceable() {
        Selection::Replaceable
    } else if event.kind == Kind(28_934) {
        Selection::Join
    } else if event.kind == Kind(28_936) {
        Selection::Leave
    } else if event.kind == Kind(28_935) {
        Selection::InviteRequest
    } else if event.kind.is_dvm_job_request() {
        Selection::DvmJob
    } else if event.kind.is_ephemeral() {
        Selection::Ephemeral
    } else if event.kind.is_delete() {
        Selection::Delete
    } else if event.kind.is_parameterized_replaceable() {
        Selection::ParameterizedReplaceable
    } else {
        Selection::Default
    }
}

/// The ordered registry: one stateless value that runs the selected arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct Strategy;

impl EventStrategy for Strategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        let selection = select(event);

        Box::pin(async move {
            match selection {
                Selection::Default => DefaultStrategy.execute(event, context).await,
                Selection::Vanish => vanish::VanishStrategy.execute(event, context).await,
                Selection::GiftWrap => gift_wrap::GiftWrapStrategy.execute(event, context).await,
                Selection::Group => group::GroupStrategy.execute(event, context).await,
                Selection::Timestamp => timestamp::TimestampStrategy.execute(event, context).await,
                Selection::ContactList => {
                    contact_list::ContactListStrategy
                        .execute(event, context)
                        .await
                }
                Selection::Report => report::ReportStrategy.execute(event, context).await,
                Selection::Replaceable => {
                    replaceable::ReplaceableStrategy
                        .execute(event, context)
                        .await
                }
                Selection::Join => {
                    join_request::JoinRequestStrategy
                        .execute(event, context)
                        .await
                }
                Selection::Leave => {
                    leave_request::LeaveRequestStrategy
                        .execute(event, context)
                        .await
                }
                Selection::InviteRequest => {
                    invite_request::InviteRequestStrategy
                        .execute(event, context)
                        .await
                }
                Selection::DvmJob => {
                    dvm_job_request::DvmJobRequestStrategy
                        .execute(event, context)
                        .await
                }
                Selection::Ephemeral => ephemeral::EphemeralStrategy.execute(event, context).await,
                Selection::Delete => delete::DeleteStrategy.execute(event, context).await,
                Selection::ParameterizedReplaceable => {
                    parameterized_replaceable::ParameterizedReplaceableStrategy
                        .execute(event, context)
                        .await
                }
            }
        })
    }
}

/// The row an arm writes: the event, its NIP-40 expiration and the socket's address.
fn event_record(event: &Event, context: &HandlerContext) -> EventRecord {
    let mut record = EventRecord::from_event(event);
    record.expires_at = expiration::get_event_expiration(event).map(i64::from);
    record.remote_address = context.connection.remote_address.parse().ok();

    record
}

/// Whether a tag value is exactly 32 bytes of lowercase hex — the rule the `delete`,
/// `gift_wrap`, `group` and `timestamp` arms apply to theirs. The report arm deliberately
/// accepts either case (`nip56::extract_report_targets`); ADR 0006 records why.
fn is_lowercase_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
mod tests {

    use super::*;
    use nostream_core::event::{EventId, Pubkey, Signature};

    fn event_of(kind: u64) -> Event {
        Event {
            id: EventId::from_byte_array([1; 32]),
            pubkey: Pubkey::from_byte_array([2; 32]),
            created_at: 1_700_000_000,
            kind: Kind(kind),
            tags: Vec::new(),
            content: String::new(),
            sig: Signature::from_byte_array([0; 64]),
        }
    }

    #[test]
    fn selection_follows_the_capture_chain() {
        let cases = [
            (62, Selection::Vanish),
            (1059, Selection::GiftWrap),
            (445, Selection::Group),
            (1040, Selection::Timestamp),
            (3, Selection::ContactList),
            (1984, Selection::Report),
            (10002, Selection::Replaceable),
            (0, Selection::Replaceable),
            (41, Selection::Replaceable),
            (10000, Selection::Replaceable),
            (19999, Selection::Replaceable),
            (28934, Selection::Join),
            (28936, Selection::Leave),
            (28935, Selection::InviteRequest),
            (5000, Selection::DvmJob),
            (5999, Selection::DvmJob),
            (20000, Selection::Ephemeral),
            (29999, Selection::Ephemeral),
            (5, Selection::Delete),
            (30000, Selection::ParameterizedReplaceable),
            (39999, Selection::ParameterizedReplaceable),
            (1, Selection::Default),
            (7, Selection::Default),
            // The capture reaches the strategy chain only after the EVENT handler rejects
            // kind 22242; if it got here, the ephemeral range would claim it.
            (22242, Selection::Ephemeral),
            (443, Selection::Default),
        ];

        for (kind, expected) in cases {
            assert_eq!(select(&event_of(kind)), expected, "kind {kind}");
        }
    }
}
