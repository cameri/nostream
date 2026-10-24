//! The `invite-request` event strategy. Mirrors
//! `src/handlers/event-strategies/invite-request-event-strategy.ts`.
//!
//! NIP-43 kind 28935 travels relay → client only: a client asks for an invite with a `REQ`, and
//! the relay answers with an event signed by the pubkey in `self`. A client-published 28935 is
//! therefore always refused, and it is refused *before* the ephemeral arm sees it — the kind sits
//! in the ephemeral range, and the clients subscribed to 28935 are exactly the ones waiting for a
//! real invite, so a broadcast here would hand anyone's forged claim tag to them.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `invite_request` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct InviteRequestStrategy;

impl EventStrategy for InviteRequestStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            tracing::debug!(
                pubkey = %event.pubkey,
                "rejecting client-published invite request"
            );

            context.send_ok(
                event.id,
                false,
                "invalid: kind 28935 is issued by the relay, request one with a REQ for kind 28935",
                None,
            );

            Ok(())
        })
    }
}
