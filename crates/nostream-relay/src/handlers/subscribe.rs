//! The `subscribe-message-handler.ts` handler.
//!
//! Normalises the filters (dedupe, drop `search` when NIP-50 is off), applies the six
//! `canSubscribe` limits with the capture's strings and its two typos, closes an
//! all-restricted REQ from an unauthenticated client, registers the subscription, mints a
//! NIP-43 invite code when the filters ask for one, then streams the stored events and ends
//! with `EOSE`. A `CLOSE`, a socket close or a tripped message limiter aborts the read with
//! no further frame.
//!
//! The in-flight read is registered **before the mint's one `await`**, as the capture sets
//! `activeSubscriptionId` as its first statement (`subscribe-message-handler.ts:53`), so a
//! `CLOSE` aborts the stored read and the subscription streams nothing. Everything through
//! that registration is the handler's ordering-sensitive prefix and runs on the connection
//! loop, so a `CLOSE` behind this `REQ` in the stream cannot be handled ahead of it — the
//! defect cameri/nostream#958 reported, closed by the decision recorded in ADR 0005. The
//! invite `EVENT` is emitted even then: the capture's emit is unguarded
//! (`subscribe-message-handler.ts:111`) and attaches its abort signal only to the stored read
//! (`:230`), and parity wins where the two disagree absent a decision record (ADR 0005).

use std::sync::Arc;

use futures_util::StreamExt;
use nostream_core::expiration;
use nostream_core::filter::{count_filter_values, normalise_subscription};
use nostream_core::messages::{EoseMessage, OutgoingEventMessage, RelayMessage, SubscribeMessage};
use nostream_core::nip42;
use nostream_core::{Filter, Kind};

use crate::connection::InFlightRead;
use crate::error::RelayError;
use crate::handlers::{HandlerContext, HandlerFuture};

/// `EventKinds.NIP43_INVITE_REQUEST`.
const INVITE_REQUEST_KIND: Kind = Kind(28_935);

/// The handler's entry point (`handleMessage`, `:51-82`).
///
/// Its ordering-sensitive prefix — everything through `begin_read` — runs on the caller's
/// task, so the connection loop has the subscription and its read registered before it reads
/// the next frame. The continuation starts at the invite mint and is spawned into the
/// socket's handler set, where it interleaves with the frames that follow.
pub fn begin(message: SubscribeMessage, context: &Arc<HandlerContext>) -> Option<HandlerFuture> {
    let (read, filters) = register(message, context)?;
    let context = Arc::clone(context);

    Some(Box::pin(async move {
        maybe_issue_invite_code(read.subscription_id(), &filters, &context).await;

        fetch_and_send(read, &filters, &context).await;
    }))
}

/// The prefix (`handleMessage`, `:51-69`): what the capture runs before its first `await`.
fn register(
    message: SubscribeMessage,
    context: &HandlerContext,
) -> Option<(InFlightRead, Vec<Filter>)> {
    let subscription_id = message.subscription_id;
    let search_enabled = context
        .settings
        .nip50
        .as_ref()
        .and_then(|nip50| nip50.enabled)
        .unwrap_or(false);
    let filters = normalise_subscription(message.filters, search_enabled);

    if let Some(reason) = can_subscribe(&subscription_id, &filters, context) {
        context.send_notice(&format!("Subscription rejected: {reason}"));
        return None;
    }

    let restricted = context.restricted_read_kinds();

    if nip42::is_subscription_auth_required(&restricted, &filters, &context.authenticated_pubkeys())
    {
        context.send_closed(
            &subscription_id,
            "auth-required: authentication is required to request these event kinds",
            None,
        );
        return None;
    }

    context
        .connection
        .subscribe(crate::connection::Subscription {
            id: subscription_id.clone(),
            filters: filters.clone(),
        });

    // Registered before the mint's only `await`, so the read a `CLOSE` aborts exists by then.
    let read = context.connection.begin_read(&subscription_id);

    Some((read, filters))
}

/// NIP-43: kind 28935 is never published by a client and never stored. A REQ for it asks the
/// relay to mint an invite code, answered with a relay-signed event on this socket only
/// (`maybeIssueInviteCode`, `:89-112`). `fetchAndSend` still runs: its EOSE ends the stored
/// read.
async fn maybe_issue_invite_code(
    subscription_id: &str,
    filters: &[Filter],
    context: &HandlerContext,
) {
    let asked = filters.iter().any(|filter| {
        filter
            .kinds
            .as_ref()
            .is_some_and(|kinds| kinds.contains(&INVITE_REQUEST_KIND))
    });

    if !asked {
        return;
    }

    match mint_invite_code(context).await {
        Ok(Some(event)) => {
            context
                .sink
                .send(&RelayMessage::Event(OutgoingEventMessage {
                    subscription_id: subscription_id.to_owned(),
                    event: std::sync::Arc::new(event),
                }));
        }
        Ok(None) => {}
        Err(error) => {
            // A failed mint must not abort the subscription: fall through to EOSE.
            tracing::warn!(error = %error, "unable to mint an invite code");
        }
    }
}

/// `mintInviteCode` (`:114-174`): every guard must pass.
async fn mint_invite_code(
    context: &HandlerContext,
) -> Result<Option<nostream_core::Event>, RelayError> {
    let Some(nip43) = context.settings.nip43.as_ref() else {
        return Ok(None);
    };

    if !nip43.enabled || nip43.allow_invite_requests != Some(true) {
        return Ok(None);
    }

    // `isRelaySelfConsistent`: an `info.self` that is configured must be the signing pubkey.
    // The capture also accepts an `npub`; this decodes only the hex form and refuses to mint
    // for an `npub` it cannot compare (ADR 0004).
    let Some(keys) = context.keys.resolve(context.relay_url()).ok() else {
        return Ok(None);
    };

    if let Some(configured) = context
        .settings
        .info
        .self_
        .as_deref()
        .filter(|value| !value.is_empty())
        && !configured.eq_ignore_ascii_case(&keys.public_key.to_string())
    {
        tracing::debug!(
            "info.self does not match the relay signing pubkey; refusing to issue invite codes"
        );
        return Ok(None);
    }

    let authenticated = context
        .connection
        .authenticated_pubkeys_in_order(context.now_secs());

    if authenticated.is_empty() {
        tracing::debug!("ignoring invite request from an unauthenticated client");
        return Ok(None);
    }

    let requester = match nip43
        .invite_request_whitelist
        .as_ref()
        .filter(|list| !list.is_empty())
    {
        Some(whitelist) => authenticated
            .iter()
            .find(|pubkey| whitelist.iter().any(|entry| entry.0 == pubkey.to_string()))
            .copied(),
        None => authenticated.first().copied(),
    };

    let Some(requester) = requester else {
        tracing::debug!(
            "ignoring invite request: no authenticated pubkey is on inviteRequestWhitelist"
        );
        return Ok(None);
    };

    match context.limits.invite_limited(&requester) {
        Ok(true) => return Ok(None),
        Ok(false) => {}
        Err(error) => {
            // Fail closed: minting writes a row, so an unavailable limiter must not open the
            // gate.
            tracing::warn!(error = %error, "invite rate limiter unavailable; skipping the mint");
            return Ok(None);
        }
    }

    let now = context.now_secs();
    let limits = nostream_core::nip43::resolve_invite_limits(
        nip43.default_max_uses,
        nip43.invite_code_expiry_seconds,
        now,
    )
    .map_err(|error| RelayError::Configuration(error.to_string()))?;

    let code = nostream_core::nip43::invite_code_from(context.random.as_ref())
        .map_err(|error| RelayError::Configuration(error.to_string()))?;

    let options = nostream_storage::repositories::CreateInviteCodeOptions {
        expires_at: limits
            .expires_at
            .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0)),
        remaining_uses: nostream_storage::repositories::FieldUpdate::Set(
            i32::try_from(limits.remaining_uses).unwrap_or(i32::MAX),
        ),
        created_by: Some(requester),
    };

    context.stores.invites.create(&code, &options).await?;

    let event =
        nostream_core::nip43::build_invite_code_event(&keys.secret_key, &code, &limits, now)
            .map_err(|error| RelayError::Configuration(error.to_string()))?;

    Ok(Some(event))
}

/// `fetchAndSend` (`:208-252`): the stored read, abortable, ending in `EOSE` unless aborted.
///
/// The read is already in flight when this runs: it is registered before the invite mint, so
/// a `CLOSE` that landed during the mint has set its cancellation.
async fn fetch_and_send(mut read: InFlightRead, filters: &[Filter], context: &HandlerContext) {
    let subscription_id = read.subscription_id().to_owned();

    // A cancellation set before the stream was opened (a `CLOSE` during the mint) ends the
    // read here: no `find_by_filters`, no frames, no `EOSE`.
    if *read.cancellation().borrow() || read.cancellation().has_changed().is_err() {
        context.connection.end_read(read);
        return;
    }

    let stream = match context.stores.events.find_by_filters(filters).await {
        Ok(stream) => stream,
        Err(error) => {
            tracing::error!(error = %error, "unable to stream events");
            context.connection.end_read(read);
            return;
        }
    };

    futures_util::pin_mut!(stream);

    let now = context.now_secs();
    let matches_any =
        |event: &nostream_core::Event| filters.iter().any(|filter| filter.matches(event));

    loop {
        if *read.cancellation().borrow() {
            context.connection.end_read(read);
            return;
        }

        // A refused frame is never queued, and the connection loop is about to close this
        // socket whatever this read does. Encoding the rest of the stream would only discard
        // it, and with a shared budget the loop can be a whole blocked write away from
        // running, so the window is not short. The sink must not latch on a budget refusal —
        // a frame that fits later is admitted — which is why the stop lives here.
        if context.sink.refusal().is_some() {
            context.connection.end_read(read);
            return;
        }

        let record = tokio::select! {
            changed = read.cancellation().changed() => {
                // An aborted read sends no frame at all, not even EOSE.
                if changed.is_err() || *read.cancellation().borrow() {
                    context.connection.end_read(read);
                    return;
                }

                continue;
            }
            record = stream.next() => match record {
                Some(record) => record,
                None => break,
            },
        };

        match record {
            Ok(record) => {
                if record.deleted_at.is_some() {
                    continue;
                }

                let event = record.event;

                // The guard is the crate's one definition of "may this socket read this
                // event"; it is asked per event, as the capture's
                // `createReadAuthorizationGuard` is, so an AUTH that lands mid-read applies to
                // the rest of the stream.
                if expiration::is_expired_event(&event, now)
                    || !context.read_authorization_guard().allows(&event)
                    || !matches_any(&event)
                {
                    continue;
                }

                context
                    .sink
                    .send(&RelayMessage::Event(OutgoingEventMessage {
                        subscription_id: subscription_id.clone(),
                        event: std::sync::Arc::new(event),
                    }));
            }
            Err(error) => {
                tracing::error!(error = %error, "error streaming events");
                break;
            }
        }
    }

    context.connection.end_read(read);

    context
        .sink
        .send(&RelayMessage::Eose(EoseMessage { subscription_id }));
}

/// `canSubscribe` (`:258-301`): six reasons, the capture's strings — including
/// `susbscription` and `less then` — and limits at `0` or absent disabled.
fn can_subscribe(
    subscription_id: &str,
    filters: &[Filter],
    context: &HandlerContext,
) -> Option<String> {
    let limits = context
        .settings
        .limits
        .as_ref()
        .and_then(|limits| limits.client.as_ref())
        .and_then(|client| client.subscription.as_ref());

    let existing = context.connection.subscription(subscription_id);

    if context
        .connection
        .has_identical_subscription(subscription_id, filters)
    {
        return Some(format!(
            "Duplicate subscription {subscription_id}: Ignoring"
        ));
    }

    let max_subscriptions = limits
        .and_then(|limits| limits.max_subscriptions)
        .unwrap_or(0);

    if max_subscriptions > 0
        && existing
            .as_ref()
            .is_none_or(|subscription| subscription.filters.is_empty())
        && context.connection.subscription_count() as u64 + 1 > max_subscriptions
    {
        return Some(format!(
            "Too many subscriptions: Number of subscriptions must be less than or equal to {max_subscriptions}"
        ));
    }

    let max_filters = limits.and_then(|limits| limits.max_filters).unwrap_or(0);

    if max_filters > 0 && filters.len() as u64 > max_filters {
        return Some(format!(
            "Too many filters: Number of filters per susbscription must be less then or equal to {max_filters}"
        ));
    }

    let max_filter_values = limits
        .and_then(|limits| limits.max_filter_values)
        .unwrap_or(0);

    if max_filter_values > 0
        && filters
            .iter()
            .any(|filter| count_filter_values(filter) as u64 > max_filter_values)
    {
        return Some(format!(
            "Too many filter values: Number of values per filter must be less than or equal to {max_filter_values}"
        ));
    }

    let max_limit = limits.and_then(|limits| limits.max_limit).unwrap_or(0);

    if max_limit > 0
        && filters
            .iter()
            .any(|filter| filter.limit.is_some_and(|limit| limit > max_limit))
    {
        return Some(format!(
            "Limit too high: Filter limit must be less than or equal to {max_limit}"
        ));
    }

    if let Some(max_id_length) = limits.and_then(|limits| limits.max_subscription_id_length)
        && subscription_id.len() as u64 > max_id_length
    {
        return Some(format!(
            "Subscription ID too long: Subscription ID must be less or equal to {max_id_length}"
        ));
    }

    None
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use nostream_core::clock::TestClock;
    use nostream_core::event::{EventId, Pubkey, Signature};
    use nostream_core::nip42::Nip42Session;

    use super::*;
    use crate::connection::Connection;
    use crate::relay_key::RelayKeySource;
    use crate::sink::{FrameBudget, FrameSink, Refusal};
    use crate::testing::{Fixture, settings};

    /// An event the fixture can hold, signed by `secret`.
    fn signed_event(secret: &[u8; 32], created_at: i64) -> nostream_core::Event {
        let mut event = nostream_core::Event {
            id: EventId::from_byte_array([0; 32]),
            pubkey: Pubkey::from_byte_array([0; 32]),
            created_at,
            kind: Kind(1),
            tags: Vec::new(),
            content: "stored".to_owned(),
            sig: Signature::from_byte_array([0; 64]),
        };

        nostream_core::crypto::sign_event(secret, &mut event).expect("sign the test event");

        event
    }

    #[tokio::test]
    async fn a_refused_sink_stops_the_read_instead_of_encoding_the_rest_of_it() {
        // Three stored events and a budget of 64 bytes: every event frame is refused and the
        // read's closing `EOSE` would fit. So the queue says which read ran — a read that
        // stopped at the first refusal leaves nothing in it, and a read that encoded and
        // discarded the rest of the stream ends with the `EOSE` that fits.
        let fixture = Fixture::new(settings());

        for index in 0..3 {
            fixture
                .seed_event(signed_event(&[7u8; 32], 1_700_000_000 + index))
                .await;
        }

        let budget = Arc::new(FrameBudget::new(64));
        let (sink, mut frames) = FrameSink::channel(64 * 1024, Some(Arc::clone(&budget)));
        let refused = sink.clone();
        let context = Arc::new(fixture.context(
            Arc::new(TestClock::new(1_700_000_000_000)),
            RelayKeySource::from_values(None, None),
            Arc::new(Connection::new(
                "127.0.0.1".to_owned(),
                Nip42Session::with_challenge("challenge", 0),
            )),
            sink,
        ));

        let message = SubscribeMessage {
            subscription_id: "s".to_owned(),
            filters: vec![Filter {
                kinds: Some(vec![Kind(1)]),
                ..Filter::default()
            }],
        };

        let read = begin(message, &context).expect("the subscription is registered");
        read.await;

        assert_eq!(refused.refusal(), Some(Refusal::BudgetExhausted));
        assert_eq!(refused.queued_bytes(), 0);
        assert!(
            frames.try_recv().is_err(),
            "the read stopped at the first refusal: no event frame and no EOSE reached the queue"
        );
        assert_eq!(
            budget.refusals(),
            1,
            "one refusal for the socket, not one per event"
        );
    }
}
