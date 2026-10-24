//! The web-of-trust seam.
//!
//! Two strategies call a trust graph at the capture: the contact-list arm replaces a pubkey's
//! follows (`updateFollowList`, `contact-list-event-strategy.ts:36`) and the report arm asks
//! how far a reporter sits from the relay's seed (`getDistance`,
//! `report-event-strategy.ts:53`).
//!
//! The graph itself is a service — `nostream-services`' `wot_graph_service`, issue #866 — and
//! this crate takes no dependency on that one: it takes the trait, the way it takes
//! [`crate::limits::Limiter`] for the rate limiter. Both callers treat the seam as
//! best-effort, so a daemon whose graph is not wired still serves.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Pubkey;

use crate::error::RelayError;

/// One web-of-trust call's future, in [`crate::strategies::EventStrategy::execute`]'s style.
pub type WotFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, RelayError>> + Send + 'a>>;

/// `IWotGraphService`: the graph's two operations.
pub trait WotGraph: Send + Sync {
    /// Replaces the pubkeys `pubkey` follows (`updateFollowList`).
    fn update_follow_list<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        follows: &'a [String],
    ) -> WotFuture<'a, ()>;

    /// The hop distance from the relay's seed to `pubkey`, `None` when it is outside the
    /// graph (`getDistance`).
    fn get_distance<'a>(&'a self, pubkey: &'a Pubkey) -> WotFuture<'a, Option<u32>>;
}
