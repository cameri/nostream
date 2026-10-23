//! The `subscribe-message-handler.ts` handler.
//!
//! Normalises the filters (dedupe, drop `search` when NIP-50 is off), applies the six
//! `canSubscribe` limits with the capture's strings and its two typos, closes an
//! all-restricted REQ from an unauthenticated client, registers the subscription, mints a
//! NIP-43 invite code when the filters ask for one, then streams the stored events and ends
//! with `EOSE`. A `CLOSE` or a tripped message limiter aborts the read with no further frame.

use futures_util::StreamExt;
use nostream_core::expiration;
use nostream_core::filter::{count_filter_values, normalise_subscription};
use nostream_core::messages::{EoseMessage, OutgoingEventMessage, RelayMessage, SubscribeMessage};
use nostream_core::nip42;
use nostream_core::{Filter, Kind};

use crate::error::RelayError;
use crate::handlers::HandlerContext;

/// `EventKinds.NIP43_INVITE_REQUEST`.
const INVITE_REQUEST_KIND: Kind = Kind(28_935);

/// The handler's entry point (`handleMessage`, `:51-82`).
pub async fn handle(message: SubscribeMessage, context: &HandlerContext) {
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
        return;
    }

    let restricted = context.restricted_read_kinds();

    if nip42::is_subscription_auth_required(&restricted, &filters, &context.authenticated_pubkeys())
    {
        context.send_closed(
            &subscription_id,
            "auth-required: authentication is required to request these event kinds",
            None,
        );
        return;
    }

    context
        .connection
        .subscribe(crate::connection::Subscription {
            id: subscription_id.clone(),
            filters: filters.clone(),
        });

    maybe_issue_invite_code(&subscription_id, &filters, context).await;

    fetch_and_send(&subscription_id, &filters, context).await;
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
async fn fetch_and_send(subscription_id: &str, filters: &[Filter], context: &HandlerContext) {
    let mut cancellation = context.connection.begin_read(subscription_id);

    let stream = match context.stores.events.find_by_filters(filters).await {
        Ok(stream) => stream,
        Err(error) => {
            tracing::error!(error = %error, "unable to stream events");
            context.connection.end_read(subscription_id);
            return;
        }
    };

    futures_util::pin_mut!(stream);

    let now = context.now_secs();
    let matches_any =
        |event: &nostream_core::Event| filters.iter().any(|filter| filter.matches(event));

    loop {
        if *cancellation.borrow() {
            context.connection.end_read(subscription_id);
            return;
        }

        let record = tokio::select! {
            changed = cancellation.changed() => {
                // An aborted read sends no frame at all, not even EOSE.
                if changed.is_err() || *cancellation.borrow() {
                    context.connection.end_read(subscription_id);
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
                let g = context.read_authorization_guard();
                println!(
                    "judging kind {} now {} auth {:?}",
                    event.kind,
                    context.now_secs(),
                    g.allows(&event)
                );
                if expiration::is_expired_event(&event, now)
                    || !context.read_authorization_guard().allows(&event)
                    || !matches_any(&event)
                {
                    continue;
                }

                context
                    .sink
                    .send(&RelayMessage::Event(OutgoingEventMessage {
                        subscription_id: subscription_id.to_owned(),
                        event: std::sync::Arc::new(event),
                    }));
            }
            Err(error) => {
                tracing::error!(error = %error, "error streaming events");
                break;
            }
        }
    }

    context.connection.end_read(subscription_id);

    context.sink.send(&RelayMessage::Eose(EoseMessage {
        subscription_id: subscription_id.to_owned(),
    }));
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
