//! The `join-request` event strategy. Mirrors
//! `src/handlers/event-strategies/join-request-event-strategy.ts`.
//!
//! NIP-43 membership, in the capture's order: the relay must have NIP-43 enabled, the request's
//! `created_at` must be within ten minutes of the relay's clock, the socket must be
//! authenticated as the requester, the event must carry a `claim` tag, the requester must not
//! already be a member, and the invite code must still be claimable. Only then is the user
//! admitted.
//!
//! The request is answered with an `OK` result and never broadcast: the claim tag is a bearer
//! secret, and anyone subscribed to kind 28934 would read it.

use std::future::Future;
use std::pin::Pin;

use chrono::{DateTime, Utc};
use nostream_core::Event;
use nostream_core::nip43::{get_claim_tag, is_request_timestamp_valid};

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `join_request` arm: kind 28934.
#[derive(Debug, Clone, Copy, Default)]
pub struct JoinRequestStrategy;

impl EventStrategy for JoinRequestStrategy {
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

            let Some(claim_code) = get_claim_tag(event) else {
                context.send_ok(
                    event.id,
                    false,
                    "invalid: join request requires a claim tag",
                    None,
                );

                return Ok(());
            };

            let existing = context.stores.users.find_by_pubkey(&event.pubkey).await?;

            if existing.is_some_and(|user| user.is_admitted) {
                context.send_ok(
                    event.id,
                    true,
                    "duplicate: you are already a member of this relay",
                    None,
                );

                return Ok(());
            }

            if !context
                .stores
                .invites
                .claim_code(claim_code, &event.pubkey)
                .await?
            {
                context.send_ok(
                    event.id,
                    false,
                    "restricted: invalid or expired invite code",
                    None,
                );

                return Ok(());
            }

            // Not transactional with the claim: if the admission fails, one code use is wasted.
            // The other order could admit a member without a valid code.
            context
                .stores
                .users
                .admit_user(&event.pubkey, admitted_at(context))
                .await?;

            context.send_ok(
                event.id,
                true,
                &format!("info: welcome to {}!", context.relay_url()),
                None,
            );

            Ok(())
        })
    }
}

/// The instant this request is admitted at, from the relay's clock (`admitUser(pubkey, new
/// Date())`). A second count outside chrono's range cannot come from a clock the relay serves
/// with; it reads as the epoch.
fn admitted_at(context: &HandlerContext) -> DateTime<Utc> {
    DateTime::from_timestamp(context.now_secs(), 0).unwrap_or(DateTime::UNIX_EPOCH)
}
