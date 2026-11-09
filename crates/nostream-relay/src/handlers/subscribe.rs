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
use nostream_core::filter::{count_filter_values, has_empty_tag_criterion, normalise_subscription};
use nostream_core::messages::{
    EOSE_HINT_AUTH, EOSE_HINT_FINISH, EOSE_HINT_MORE, EoseMessage, OutgoingEventMessage,
    RelayMessage, SubscribeMessage,
};
use nostream_core::nip42;
use nostream_core::{Filter, Kind};
use nostream_storage::repositories::{EmptyTagRule, SearchRule, StreamedEvent};

use crate::connection::InFlightRead;
use crate::error::RelayError;
use crate::handlers::{HandlerContext, HandlerFuture};
use crate::sink::Refusal;

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
///
/// The `EOSE` may carry NIP-67's third element (`67.md` §"Specification"), and only from the
/// two causes that make the two-element form misleading: the read guard withheld a matching
/// event (`auth`), or a single-filter subscription's `limit` decided the answer
/// (`finish`/`more`). A read with neither cause keeps `["EOSE", <id>]`, which is what makes
/// every recorded session's EOSE byte-identical to the capture's.
async fn fetch_and_send(mut read: InFlightRead, filters: &[Filter], context: &HandlerContext) {
    let subscription_id = read.subscription_id().to_owned();

    // A cancellation set before the stream was opened (a `CLOSE` during the mint) ends the
    // read here: no `find_by_filters`, no frames, no `EOSE`.
    if *read.cancellation().borrow() || read.cancellation().has_changed().is_err() {
        context.connection.end_read(read);
        return;
    }

    // NIP-67 can only be answered exactly for a single filter carrying a `limit`: a
    // multi-filter union is deduplicated after each filter's own limit, so "did this
    // subscription's cap cut the result" has no cheap exact answer there — and `more` is
    // optional in the NIP for exactly that reason.
    let hint_eligible = filters.len() == 1 && filters[0].limit.is_some();
    let limit = if hint_eligible {
        filters[0].limit
    } else {
        None
    };

    // The probe: ask storage for one more row than the client's cap, so a `(limit + 1)`th
    // **matching** row is what says `more` without being sent. `u64::MAX` saturates, which
    // admits nothing beyond the maximum and so cannot hide a row. The backends already honour
    // `limit`; the in-memory double does not, and the loop below drops the extra row either way.
    let probe = limit.map(|limit| limit.saturating_add(1));
    // Only a probing read needs new filters, and it only rewrites `limit`: every other read
    // borrows the subscription's own list rather than copying it (a 1 000-author filter costs
    // 63 µs to clone, and the copy buys nothing).
    let probed;
    let storage_filters: &[Filter] = match probe {
        Some(probe) => {
            probed = filters
                .iter()
                .map(|filter| Filter {
                    limit: Some(probe),
                    ..filter.clone()
                })
                .collect::<Vec<Filter>>();
            &probed
        }
        None => filters,
    };

    let stream = match context.stores.events.find_by_filters(storage_filters).await {
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

    // `rows`: every row the page yielded, skipped ones included — a full page is what makes the
    // backend's remaining extent unknown. `matched`: rows that were a match inside the client's
    // window, which is what `limit` bounds. `trimmed`: the guard withheld a match. `more`: a
    // match beyond the window was found. `failed`: the stream errored. `refused`: the backend
    // yielded a row this relay's matcher refuses, which is what a backend whose predicate is not
    // `Filter::matches` looks like from here. `vanished`: the backend spent a page slot on a key
    // that was gone when it came to read it.
    let mut rows = 0u64;
    let mut matched = 0u64;
    let mut trimmed = false;
    let mut more = false;
    let mut failed = false;
    let mut refused = false;
    let mut vanished = false;

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
        //
        // The read then parks instead of unwinding: it has nothing left to send, and parking
        // keeps the close's promptness a property of the refusal signal rather than of this
        // handler happening to finish. On the refusal path the loop's `abort_all` drops the
        // parked task before the watch below ever resolves, so the `end_read` after it is the
        // path a client `CLOSE` or a re-`REQ` takes, not the refusal's. It is the same call
        // every other exit of this function makes, and it is safe beside the loop's own
        // `close` because it removes the entry only while the generation it carries still
        // matches (`connection.rs:290-297`): whichever of the two runs second does nothing.
        match context.sink.refusal() {
            Refusal::None => {}
            Refusal::QueueFull | Refusal::BudgetExhausted => {
                let _ = read.cancellation().changed().await;
                context.connection.end_read(read);
                return;
            }
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
            Ok(StreamedEvent::Record(record)) => {
                // Every row the page yielded counts towards whether the page was full, whether
                // or not it turns out to be a match.
                rows += 1;

                if record.deleted_at.is_some() {
                    continue;
                }
                let event = record.event;

                if expiration::is_expired_event(&event, now) {
                    continue;
                }

                if !matches_any(&event) {
                    // The backend selected a row this relay's own matcher refuses. That is not a
                    // skip: it is evidence that the set the backend enumerated is not the set the
                    // relay would have, so completeness over this read cannot be claimed. It is
                    // tracked apart from `trimmed` because a refused row is one **no** client
                    // could see, while `auth` means "a client could see this".
                    refused = true;

                    continue;
                }

                // The `(limit + 1)`th matching row is beyond the cap, so nothing after it can
                // change the answer: it sets `more` and ends the read undelivered.
                if let Some(limit) = limit
                    && matched >= limit
                {
                    more = true;
                    break;
                }

                matched += 1;

                // The guard is the crate's one definition of "may this socket read this
                // event"; it is asked per event, as the capture's
                // `createReadAuthorizationGuard` is, so an AUTH that lands mid-read applies to
                // the rest of the stream. A withheld row still occupied a place inside the
                // cap, which is why the counter moves before the guard is asked.
                if !context.read_authorization_guard().allows(&event) {
                    trimmed = true;

                    continue;
                }

                context
                    .sink
                    .send(&RelayMessage::Event(OutgoingEventMessage {
                        subscription_id: subscription_id.clone(),
                        event: std::sync::Arc::new(event),
                    }));
            }
            Ok(StreamedEvent::Vanished) => {
                // The backend selected this slot and the key was gone when it read the value, so
                // the slot is spent without a record. It counts as a row, exactly as a skipped row
                // does, so a page that was full at enumeration is full by count and `page_full`
                // withholds on its own. What the count cannot carry is the page that **never
                // filled**: fewer rows than the probe, so `page_full` is false, and a slot that
                // was a match when the page was enumerated produced nothing when it was read. That
                // slot may have been deleted — `finish` would still be true over the current set —
                // or replaced, in which case the new version was never enumerated and `finish` is
                // false, and the read cannot tell the two apart, so it declines rather than
                // argues.
                rows += 1;
                vanished = true;
            }
            Err(error) => {
                tracing::error!(error = %error, "error streaming events");
                failed = true;

                break;
            }
        }
    }

    context.connection.end_read(read);

    // The rule, in one place, so the next reader does not have to re-derive it. `finish` claims
    // that every stored event matching the subscription's filters has been sent (`67.md`
    // §"Specification"), and this read can fail to establish that six ways, so `finish` needs
    // all six:
    //
    // 1. the stream ended **cleanly** — after a storage error, how far the read got is unknown;
    // 2. the page was **not full** — a page that yielded `min(probe, page_bound())` rows says
    //    nothing about the rows beyond it, whether the bound came from the client's `limit` or
    //    from the backend's own page cap, and a skipped row spends a page slot just as a match
    //    does (which is why `rows`, not `matched`, decides this);
    // 3. **no page slot was spent without its row** — a backend reports a slot it selected and
    //    then could not read as `StreamedEvent::Vanished`, and that slot is counted as a row, so
    //    a page that was full at enumeration is full by count and item 2 withholds on its own.
    //    The marker's own work is the page that **never filled**: fewer rows than the probe, so
    //    `page_full` is false, and a slot that was a match when the page was enumerated produced
    //    nothing when it was read. That slot may have been deleted — `finish` would still be
    //    true over the current set — or replaced, in which case the new version was never
    //    enumerated and `finish` is false, and the read cannot tell the two apart, so it
    //    declines rather than argues;
    // 4. **no yielded row was refused** — the backend selected a row `Filter::matches` refuses,
    //    which proves the two predicates disagree, so a short page proves nothing about the rows
    //    the backend never yielded;
    // 5. **no `search` filter was answered by another predicate** — Postgres prefilters with
    //    `to_tsvector`, and a row the matcher *would* accept and the backend never yields
    //    (`abcdef` inside `xxabcdefyy`) leaves no trace at all, so the backend declares its rule
    //    rather than the read probing for it. See `EventRepository::search_rule`;
    // 6. **no tag criterion that is the empty string was read from an index without one** — the
    //    matcher accepts a `["d", ""]` tag, an index of non-empty values selects nothing for
    //    the criterion `""`, and nothing is yielded to refuse, so like item 5 the enumeration
    //    could not answer a criterion the matcher accepts and no probe shows it. See
    //    `EventRepository::empty_tag_rule`.
    //
    // Items 4 and 5 are both needed and neither implies the other: a refusal is the direction a
    // probe can see (`study` yields `studies`, which the matcher refuses), while a row the
    // matcher would accept and the backend never yields leaves no trace at all.
    //
    // Beyond the six, `more` needs one further **match** beyond the delivered window: that branch
    // ends the read with `more` set, so the code that can reach the hint is the code where none
    // was found. It is only meaningful once items 1 and 2 hold, because the loop keeps asking
    // past deleted, expired, withheld and non-matching rows until it sees a match, the genuine
    // end, or the page cap.
    //
    // Where any of the six cannot be established the relay sends no completeness hint: an absent
    // hint is honest and a wrong one is not. `auth` is unaffected, and `finish` is never sent
    // beside `auth` because a withheld event falsifies it.
    let page_bound = context.stores.events.page_bound();
    let page_full = probe.is_some_and(|probe| rows >= probe.min(page_bound));
    let search_rule = context.stores.events.search_rule();
    let searched = filters.iter().any(|filter| {
        filter
            .search
            .as_deref()
            .is_some_and(|search| !search.trim().is_empty())
    });
    let search_agrees = search_rule == SearchRule::SubstringTerms || !searched;
    // A tag criterion that is the empty string is one `Filter::matches` accepts and a tag index
    // built from non-empty values cannot answer: nothing is yielded, so neither a refusal nor a
    // short page shows it, and the enumeration could not answer a criterion the matcher accepts.
    let empty_tag_query = filters.iter().any(has_empty_tag_criterion);
    let tag_agrees = context.stores.events.empty_tag_rule() == EmptyTagRule::AnswersEmptyCriterion
        || !empty_tag_query;
    let proven = !failed && !page_full && !vanished && !refused && search_agrees && tag_agrees;

    let mut hints = Vec::new();

    if trimmed {
        hints.push(EOSE_HINT_AUTH.to_owned());
    }

    if hint_eligible {
        if more {
            hints.push(EOSE_HINT_MORE.to_owned());
        } else if proven && !trimmed {
            hints.push(EOSE_HINT_FINISH.to_owned());
        }
    }

    context.sink.send(&RelayMessage::Eose(EoseMessage {
        subscription_id,
        hints,
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use std::time::Duration;

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
        // Three stored events behind a per-item gate, and a 64-byte budget: every event frame
        // is refused, so the read must neither take another record nor encode one. The gate is
        // the measure — two permits left means one record was taken and the stream was not
        // drained — and the queue is the other: a read that ran on to the end would leave the
        // 12-byte `EOSE` in it, which does fit.
        let fixture = Fixture::new(settings());
        let gate = fixture.events.gate_reads_per_item();

        for index in 0..3 {
            fixture
                .seed_event(signed_event(&[7u8; 32], 1_700_000_000 + index))
                .await;
        }

        let budget = Arc::new(FrameBudget::new(64));
        let (sink, mut frames) = FrameSink::channel(64 * 1024, Some(Arc::clone(&budget)));
        let refused = sink.clone();
        let connection = Arc::new(Connection::new(
            "127.0.0.1".to_owned(),
            Nip42Session::with_challenge("challenge", 0),
        ));
        let context = Arc::new(fixture.context(
            Arc::new(TestClock::new(1_700_000_000_000)),
            RelayKeySource::from_values(None, None),
            Arc::clone(&connection),
            sink,
        ));

        let message = SubscribeMessage {
            subscription_id: "s".to_owned(),
            filters: vec![Filter {
                kinds: Some(vec![Kind(1)]),
                ..Filter::default()
            }],
        };

        let mut read = begin(message, &context).expect("the subscription is registered");
        gate.add_permits(3);

        assert!(
            tokio::time::timeout(Duration::from_millis(200), &mut read)
                .await
                .is_err(),
            "the read parks once its frame is refused instead of draining the stream"
        );
        assert_eq!(refused.refusal(), Refusal::BudgetExhausted);
        assert_eq!(
            gate.available_permits(),
            2,
            "one record was taken and the rest of the stream was never asked for"
        );
        assert!(frames.try_recv().is_err(), "no EOSE reached the queue");
        assert_eq!(refused.queued_bytes(), 0);
        assert_eq!(
            budget.refusals(),
            1,
            "one refusal for the socket, not one per event"
        );

        // The close the read is waiting for ends it.
        connection.close();
        tokio::time::timeout(Duration::from_secs(1), read)
            .await
            .expect("the connection's close ends the read");
    }
}
