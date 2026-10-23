//! The event strategies. Mirrors `src/handlers/event-strategies/*-event-strategy.ts` and the
//! selection chain of `src/factories/event-strategy-factory.ts:56-108`.
//!
//! The trait is `IEventStrategy.execute` (one method, `(event, sink)`); the registry
//! [`select`]s the arm in the capture's order — which **is** the policy — and [`Strategy`]
//! runs it. `default` is implemented here; the other fourteen modules are labelled stubs for
//! job 009.

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

use nostream_core::{Event, Kind};

use crate::error::RelayError;
use crate::handlers::HandlerContext;

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
                Selection::Default => default::DefaultStrategy.execute(event, context).await,
                Selection::Vanish => vanish::execute(event, context).await,
                Selection::GiftWrap => gift_wrap::execute(event, context).await,
                Selection::Group => group::execute(event, context).await,
                Selection::Timestamp => timestamp::execute(event, context).await,
                Selection::ContactList => contact_list::execute(event, context).await,
                Selection::Report => report::execute(event, context).await,
                Selection::Replaceable => replaceable::execute(event, context).await,
                Selection::Join => join_request::execute(event, context).await,
                Selection::Leave => leave_request::execute(event, context).await,
                Selection::InviteRequest => invite_request::execute(event, context).await,
                Selection::DvmJob => dvm_job_request::execute(event, context).await,
                Selection::Ephemeral => ephemeral::execute(event, context).await,
                Selection::Delete => delete::execute(event, context).await,
                Selection::ParameterizedReplaceable => {
                    parameterized_replaceable::execute(event, context).await
                }
            }
        })
    }
}

#[cfg(test)]
mod stubs {
    //! AC27: each of the fourteen arms is honestly stubbed.

    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

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

    #[test]
    fn every_unfilled_arm_returns_not_implemented() {
        use nostream_core::clock::SystemClock;
        use std::sync::Arc;

        // The stub bodies do not read the context, so a sink that drops everything stands in
        // for a socket.
        let fixture = crate::testing::Fixture::new(crate::testing::settings());
        let context = fixture.anonymous_context(
            Arc::new(SystemClock),
            crate::relay_key::RelayKeySource::from_values(None, None),
        );

        let selections = [
            (Selection::Vanish, "relay::strategies::vanish"),
            (Selection::GiftWrap, "relay::strategies::gift_wrap"),
            (Selection::Group, "relay::strategies::group"),
            (Selection::Timestamp, "relay::strategies::timestamp"),
            (Selection::ContactList, "relay::strategies::contact_list"),
            (Selection::Report, "relay::strategies::report"),
            (Selection::Replaceable, "relay::strategies::replaceable"),
            (Selection::Join, "relay::strategies::join_request"),
            (Selection::Leave, "relay::strategies::leave_request"),
            (
                Selection::InviteRequest,
                "relay::strategies::invite_request",
            ),
            (Selection::DvmJob, "relay::strategies::dvm_job_request"),
            (Selection::Ephemeral, "relay::strategies::ephemeral"),
            (Selection::Delete, "relay::strategies::delete"),
            (
                Selection::ParameterizedReplaceable,
                "relay::strategies::parameterized_replaceable",
            ),
        ];

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            for (selection, module) in selections {
                let outcome = match selection {
                    Selection::Vanish => vanish::execute(&event_of(62), &context).await,
                    Selection::GiftWrap => gift_wrap::execute(&event_of(1059), &context).await,
                    Selection::Group => group::execute(&event_of(445), &context).await,
                    Selection::Timestamp => timestamp::execute(&event_of(1040), &context).await,
                    Selection::ContactList => contact_list::execute(&event_of(3), &context).await,
                    Selection::Report => report::execute(&event_of(1984), &context).await,
                    Selection::Replaceable => replaceable::execute(&event_of(0), &context).await,
                    Selection::Join => join_request::execute(&event_of(28934), &context).await,
                    Selection::Leave => leave_request::execute(&event_of(28936), &context).await,
                    Selection::InviteRequest => {
                        invite_request::execute(&event_of(28935), &context).await
                    }
                    Selection::DvmJob => dvm_job_request::execute(&event_of(5000), &context).await,
                    Selection::Ephemeral => ephemeral::execute(&event_of(20000), &context).await,
                    Selection::Delete => delete::execute(&event_of(5), &context).await,
                    Selection::ParameterizedReplaceable => {
                        parameterized_replaceable::execute(&event_of(30000), &context).await
                    }
                    Selection::Default => unreachable!("default is implemented"),
                };

                match outcome {
                    Err(RelayError::NotImplemented { module: reported }) => {
                        assert_eq!(reported, module, "{selection:?}");
                    }
                    // Anything but `NotImplemented` means the arm was wired without a
                    // port: `assert` rather than `panic!`, and the message names the arm.
                    other => assert!(
                        matches!(other, Err(RelayError::NotImplemented { .. })),
                        "{selection:?} must be a NotImplemented stub, got {other:?}"
                    ),
                }
            }
        });
    }
}
