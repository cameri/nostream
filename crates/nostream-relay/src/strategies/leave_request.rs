//! The `leave-request` event strategy. Mirrors
//! `src/handlers/event-strategies/leave-request-event-strategy.ts`.
//!
//! NIP-43 membership departure, in the capture's order: the relay must have NIP-43 enabled, the
//! request must carry the NIP-70 `-` tag, its `created_at` must be within ten minutes of the
//! relay's clock, the socket must be authenticated as the requester, and only a member who is
//! currently admitted is revoked. A non-member is answered `["OK",<id>,true,""]` without a write,
//! which keeps the arm from creating a phantom user row.
//!
//! The `-` tag is checked **before** the timestamp — the capture's order, and the reverse of the
//! join arm's, which has no `-` check at all. The request is never broadcast.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;
use nostream_core::nip43::is_request_timestamp_valid;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `leave_request` arm: kind 28936.
#[derive(Debug, Clone, Copy, Default)]
pub struct LeaveRequestStrategy;

impl EventStrategy for LeaveRequestStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            if !context
                .settings
                .nip43
                .as_ref()
                .is_some_and(|nip43| nip43.enabled)
            {
                context.send_ok(
                    event.id,
                    false,
                    "restricted: NIP-43 is not enabled on this relay",
                    None,
                );

                return Ok(());
            }

            if !event.is_protected() {
                context.send_ok(
                    event.id,
                    false,
                    "invalid: leave request requires a NIP-70 \"-\" tag",
                    None,
                );

                return Ok(());
            }

            if !is_request_timestamp_valid(event.created_at, context.now_secs()) {
                context.send_ok(
                    event.id,
                    false,
                    "invalid: created_at is too far from the current time",
                    None,
                );

                return Ok(());
            }

            if !context
                .authenticated_pubkeys()
                .contains(&event.pubkey)
            {
                context.send_ok(
                    event.id,
                    false,
                    "auth-required: authentication required (NIP-42)",
                    None,
                );

                return Ok(());
            }

            let existing = context.stores.users.find_by_pubkey(&event.pubkey).await?;

            if !existing.is_some_and(|user| user.is_admitted) {
                context.send_ok(event.id, true, "", None);

                return Ok(());
            }

            context
                .stores
                .users
                .revoke_admission(&event.pubkey)
                .await?;

            context.send_ok(event.id, true, "", None);

            Ok(())
        })
    }
}
