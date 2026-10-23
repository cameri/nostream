//! The `event-message-handler.ts` handler.
//!
//! The pipeline is the capture's, in the capture's order
//! (`src/handlers/event-message-handler.ts:66-167`), and every reason string is verbatim:
//! validity → expiry → event rate limit → acceptance gate → authentication → protected
//! events → request-to-vanish → admission → NIP-05 → adaptive-PoW sample → strategy dispatch.

use nostream_config::settings::{ContentLimits, ContentLimitsOrVec, Settings};
use nostream_core::adaptive_pow::{self, AdaptivePowConfig, WotPowThreshold};
use nostream_core::constants::ALL_RELAYS;
use nostream_core::nip05;
use nostream_core::{Event, Kind, crypto, expiration, pow, time};

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::limits::kind_selector_matches;
use crate::strategies::{EventStrategy, Strategy};

/// `EventKinds.REACTION`.
const REACTION_KIND: Kind = Kind(7);

/// `EventKinds.SET_METADATA`.
const SET_METADATA_KIND: Kind = Kind(0);

/// `EventKinds.REPOST` and `EventKinds.GENERIC_REPOST`.
const REPOST_KINDS: [Kind; 2] = [Kind(6), Kind(16)];

/// `EventKinds.AUTH`.
const AUTH_KIND: Kind = Kind(22_242);

/// `EventKinds.NIP43_JOIN_REQUEST`, `NIP43_INVITE_REQUEST`, `NIP43_LEAVE_REQUEST`.
const NIP43_REQUEST_KINDS: [Kind; 3] = [Kind(28_934), Kind(28_935), Kind(28_936)];

/// The handler's entry point (`handleMessage`).
pub async fn handle(event: Event, context: &HandlerContext) {
    if let Some(reason) = is_event_valid(&event, context.relay_url()) {
        context.send_ok(event.id, false, &reason, None);
        return;
    }

    let now = context.now_secs();

    if expiration::is_expired_event(&event, now) {
        context.send_ok(event.id, false, "event is expired", None);
        return;
    }

    // The capture resolves the relay key at the top of `isRateLimited`; without one the
    // throw surfaces as this frame (measured; ADR 0004).
    let relay_public_key = match context.keys.resolve(context.relay_url()) {
        Ok(keys) => keys.public_key,
        Err(error) => {
            tracing::debug!(error = %error, "no relay signing key; refusing the event");
            context.send_ok(event.id, false, "error: unable to process event", None);
            return;
        }
    };

    match context.limits.event_backoff(
        &event,
        &context.connection.remote_address,
        Some(&relay_public_key),
    ) {
        Ok(Some(backoff)) => {
            context.send_ok(
                event.id,
                false,
                "rate-limited: slow down",
                Some(backoff.to_string()),
            );
            return;
        }
        Ok(None) => {}
        Err(error) => {
            // Fail closed: an unavailable limiter must not leave the gate open.
            tracing::warn!(error = %error, "rate limiter unavailable; refusing the event");
            context.send_ok(event.id, false, "rate-limited: slow down", None);
            return;
        }
    }

    if let Some(reason) = can_accept_event(&event, context, now, &relay_public_key) {
        context.send_ok(event.id, false, &reason, None);
        return;
    }

    if let Some(reason) = is_authentication_required(&event, context, &relay_public_key) {
        context.send_ok(event.id, false, &reason, None);
        return;
    }

    if let Some(reason) = is_protected_event_blocked(&event, context).await {
        context.send_ok(event.id, false, &reason, None);
        return;
    }

    if let Some(reason) = is_blocked_by_request_to_vanish(&event, context, &relay_public_key).await
    {
        context.send_ok(event.id, false, &reason, None);
        return;
    }

    if let Some(reason) = is_user_admitted(&event, context, &relay_public_key).await {
        context.send_ok(event.id, false, &reason, None);
        return;
    }

    if let Some(reason) = check_nip05_verification(&event, context, &relay_public_key).await {
        context.send_ok(event.id, false, &reason, None);
        return;
    }

    if let Some(pow_settings) = context
        .settings
        .limits
        .as_ref()
        .and_then(|limits| limits.event.as_ref())
        .and_then(|event| event.pow.as_ref())
        .filter(|pow| pow.enabled)
    {
        let mut state = context
            .pow
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        state.record_event(pow_settings.period_ms, context.now_ms());
    }

    // The capture's `error: event not supported` branch is the factory returning nothing;
    // the registry always selects an arm, so it has no occurrence here.
    if let Err(error) = Strategy.execute(&event, context).await {
        match &error {
            RelayError::NotImplemented { module } => {
                tracing::debug!(module, "strategy is not implemented in this job");
            }
            other => tracing::error!(error = %other, "event strategy failed"),
        }

        context.send_ok(event.id, false, "error: unable to process event", None);
    }
}

/// `isEventValid` (`:333-358`).
fn is_event_valid(event: &Event, relay_url: &str) -> Option<String> {
    match crypto::compute_event_id(event) {
        Ok(id) if id == event.id => {}
        _ => return Some("invalid: event id does not match".to_owned()),
    }

    if crypto::verify_event_signature(event).is_err() {
        return Some("invalid: event signature verification failed".to_owned());
    }

    if event.kind == Kind::REQUEST_TO_VANISH && !event.is_request_to_vanish(Some(relay_url)) {
        return Some("invalid: request to vanish relay tag invalid".to_owned());
    }

    if matches!(
        event.kind,
        Kind::SEAL | Kind::DIRECT_MESSAGE | Kind::FILE_MESSAGE | Kind::MARMOT_WELCOME_RUMOR
    ) {
        return Some(format!(
            "blocked: kind {} events must not be published directly; wrap them in a kind 1059 gift wrap",
            event.kind
        ));
    }

    if event.kind == AUTH_KIND {
        return Some("invalid: auth events must be sent using the AUTH message type".to_owned());
    }

    None
}

/// `canAcceptEvent` (`:175-283`).
fn can_accept_event(
    event: &Event,
    context: &HandlerContext,
    now: i64,
    relay_public_key: &nostream_core::Pubkey,
) -> Option<String> {
    if event.pubkey == *relay_public_key {
        return None;
    }

    let settings: &Settings = context.settings.as_ref();
    let limits = settings
        .limits
        .as_ref()
        .and_then(|limits| limits.event.as_ref());

    if let Some(limits) = limits {
        for content in content_limits(limits.content.as_ref()) {
            if let Some(reason) = check_content_limit(event, content) {
                return Some(reason);
            }
        }

        if let Some(created_at) = &limits.created_at
            && let Err(error) = time::check_created_at(
                event.created_at,
                now,
                created_at.max_positive_delta,
                created_at.max_negative_delta,
            )
        {
            // The error's text already carries the capture's `rejected: ` prefix.
            return Some(error.to_string());
        }

        if let Some(pow_settings) = limits.pow.as_ref().filter(|pow| pow.enabled) {
            let required = required_difficulty(pow_settings, context, event);
            let observed = pow::leading_zero_bits(event.id.as_bytes());

            if observed < required {
                return Some(format!("pow: difficulty {observed}<{required}"));
            }
        } else if let Some(minimum) = limits
            .event_id
            .as_ref()
            .and_then(|event_id| event_id.min_leading_zero_bits)
            .filter(|minimum| *minimum > 0)
        {
            let observed = pow::leading_zero_bits(event.id.as_bytes());

            if observed < minimum {
                return Some(format!("pow: difficulty {observed}<{minimum}"));
            }
        }

        if let Some(minimum) = limits
            .pubkey
            .as_ref()
            .map(|pubkey| pubkey.min_leading_zero_bits)
            .filter(|minimum| *minimum > 0)
        {
            let observed = pow::leading_zero_bits(event.pubkey.as_bytes());

            if observed < minimum {
                return Some(format!("pow: pubkey difficulty {observed}<{minimum}"));
            }
        }

        if let Some(pubkey_limits) = &limits.pubkey {
            let pubkey = event.pubkey.to_string();

            if pubkey_limits.whitelist.as_ref().is_some_and(|whitelist| {
                !whitelist.is_empty() && !whitelist.iter().any(|entry| entry.0 == pubkey)
            }) {
                return Some("blocked: pubkey not allowed".to_owned());
            }

            if pubkey_limits
                .blacklist
                .as_ref()
                .is_some_and(|blacklist| blacklist.iter().any(|entry| entry.0 == pubkey))
            {
                return Some("blocked: pubkey not allowed".to_owned());
            }
        }

        if let Some(kind_limits) = &limits.kind {
            if kind_limits.whitelist.as_ref().is_some_and(|whitelist| {
                !whitelist.is_empty()
                    && !whitelist
                        .iter()
                        .any(|selector| kind_selector_matches(*selector, event.kind))
            }) {
                return Some(format!("blocked: event kind {} not allowed", event.kind));
            }

            if kind_limits.blacklist.as_ref().is_some_and(|blacklist| {
                blacklist
                    .iter()
                    .any(|selector| kind_selector_matches(*selector, event.kind))
            }) {
                return Some(format!("blocked: event kind {} not allowed", event.kind));
            }
        }
    }

    None
}

/// `ContentLimits | ContentLimits[]`: one rule or a list of them.
fn content_limits(limits: Option<&ContentLimitsOrVec>) -> Vec<&ContentLimits> {
    match limits {
        Some(ContentLimitsOrVec::One(limit)) => vec![limit],
        Some(ContentLimitsOrVec::Many(limits)) => limits.iter().collect(),
        None => Vec::new(),
    }
}

fn check_content_limit(event: &Event, limit: &ContentLimits) -> Option<String> {
    let max_length = limit.max_length.filter(|max_length| *max_length > 0)?;

    // `String.prototype.length` counts UTF-16 code units.
    let length = event.content.encode_utf16().count() as u64;

    if length <= max_length {
        return None;
    }

    let applies = limit.kinds.as_ref().is_none_or(|kinds| {
        kinds
            .iter()
            .any(|selector| kind_selector_matches(*selector, event.kind))
    });

    applies.then(|| format!("rejected: content is longer than {max_length} bytes"))
}

/// The adaptive difficulty after the WoT reduction (`getCurrentDifficulty` +
/// `applyWotPowPolicy`).
///
/// The WoT distance is `nostream-services`' graph, which no crate implements yet, so the
/// lookup yields `None` — the capture's own treatment of a pubkey outside the trust graph.
fn required_difficulty(
    settings: &nostream_config::settings::AdaptivePowSettings,
    context: &HandlerContext,
    _event: &Event,
) -> u32 {
    let config = AdaptivePowConfig {
        enabled: settings.enabled,
        floor_bits: settings.floor_bits,
        ceiling_bits: settings.ceiling_bits,
        target_events_per_second: settings.target_events_per_second,
        period_ms: settings.period_ms,
    };

    let observed = context
        .pow
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .current_events_per_second(settings.period_ms);

    let computed =
        adaptive_pow::compute_difficulty(&config, observed).unwrap_or(settings.floor_bits);

    let thresholds: Option<Vec<WotPowThreshold>> =
        settings.wot_thresholds.as_ref().map(|thresholds| {
            thresholds
                .iter()
                .map(|threshold| WotPowThreshold {
                    max_distance: threshold.max_distance,
                    difficulty_factor: threshold.difficulty_factor,
                })
                .collect()
        });

    adaptive_pow::apply_wot_pow_policy(computed, None, thresholds.as_deref())
}

/// `isAuthenticationRequired` (`:285-297`).
fn is_authentication_required(
    event: &Event,
    context: &HandlerContext,
    relay_public_key: &nostream_core::Pubkey,
) -> Option<String> {
    let required = context
        .settings
        .nip42
        .as_ref()
        .and_then(|nipp42| nipp42.auth_required)
        .unwrap_or(false);

    if !required {
        return None;
    }

    if event.pubkey == *relay_public_key {
        return None;
    }

    if !context.authenticated_pubkeys().contains(&event.pubkey) {
        return Some("auth-required: authentication is required to publish events".to_owned());
    }

    None
}

/// `isProtectedEventBlocked` (`:299-331`).
async fn is_protected_event_blocked(event: &Event, context: &HandlerContext) -> Option<String> {
    if event.is_protected() && !context.authenticated_pubkeys().contains(&event.pubkey) {
        return Some("auth-required: this event may only be published by its author".to_owned());
    }

    if embeds_protected_event(event, 0) == Some(true) {
        return Some("blocked: reposts must not embed protected events".to_owned());
    }

    None
}

/// The capture's `checkEmbedded`: a kind-6/16 repost whose content parses as an event that
/// verifies and carries the NIP-70 tag, at any depth up to ten.
fn embeds_protected_event(event: &Event, depth: u32) -> Option<bool> {
    if depth > 10 {
        return Some(false);
    }

    if !REPOST_KINDS.contains(&event.kind) || event.content.is_empty() {
        return Some(false);
    }

    let value: serde_json::Value = match serde_json::from_str(&event.content) {
        Ok(value) => value,
        Err(_) => return Some(false),
    };

    let embedded = match nostream_core::messages::validate_event_value(&value) {
        Ok(embedded) => embedded,
        Err(_) => return Some(false),
    };

    if crypto::compute_event_id(&embedded).ok() != Some(embedded.id)
        || crypto::verify_event_signature(&embedded).is_err()
    {
        return Some(false);
    }

    if embedded.is_protected() {
        return Some(true);
    }

    embeds_protected_event(&embedded, depth + 1)
}

/// `isBlockedByRequestToVanish` (`:360-374`).
async fn is_blocked_by_request_to_vanish(
    event: &Event,
    context: &HandlerContext,
    relay_public_key: &nostream_core::Pubkey,
) -> Option<String> {
    if event.kind == Kind::REQUEST_TO_VANISH {
        return None;
    }

    if event.pubkey == *relay_public_key {
        return None;
    }

    match context.stores.users.is_vanished(&event.pubkey).await {
        Ok(true) => Some("blocked: request to vanish active for pubkey".to_owned()),
        Ok(false) => None,
        Err(error) => {
            tracing::error!(error = %error, "admission read failed; refusing the event");
            Some("blocked: pubkey not admitted".to_owned())
        }
    }
}

/// `isUserAdmitted` (`:445-522`).
async fn is_user_admitted(
    event: &Event,
    context: &HandlerContext,
    relay_public_key: &nostream_core::Pubkey,
) -> Option<String> {
    let settings: &Settings = context.settings.as_ref();
    let payments_enabled = settings
        .payments
        .as_ref()
        .is_some_and(|payments| payments.enabled);
    let nip43_enabled = settings.nip43.as_ref().is_some_and(|nip43| nip43.enabled);

    if !payments_enabled && !nip43_enabled {
        return None;
    }

    if event.pubkey == *relay_public_key {
        return None;
    }

    // Join, leave and invite requests are the admission flow itself, and the invite request
    // must reach its strategy to answer "use a REQ instead".
    if NIP43_REQUEST_KINDS.contains(&event.kind) {
        return None;
    }

    let fee_schedules = payments_enabled
        .then(|| {
            settings
                .payments
                .as_ref()
                .map(|payments| &payments.fee_schedules)
        })
        .flatten()
        .map(|schedules| {
            schedules
                .admission
                .iter()
                .filter(|schedule| {
                    schedule.enabled
                        && !schedule
                            .whitelists
                            .as_ref()
                            .and_then(|whitelists| whitelists.pubkeys.as_ref())
                            .is_some_and(|pubkeys| {
                                pubkeys
                                    .iter()
                                    .any(|pubkey| pubkey.0 == event.pubkey.to_string())
                            })
                        && !schedule
                            .whitelists
                            .as_ref()
                            .and_then(|whitelists| whitelists.event_kinds.as_ref())
                            .is_some_and(|kinds| {
                                kinds
                                    .iter()
                                    .any(|selector| kind_selector_matches(*selector, event.kind))
                            })
                })
                .count()
        });

    let admission_fee_required = fee_schedules.is_some_and(|count| count > 0);

    if !admission_fee_required && !nip43_enabled {
        return None;
    }

    let not_admitted_reason = if nip43_enabled {
        "restricted: pubkey not admitted; send a join request (kind 28934) with a valid invite code"
    } else {
        "blocked: pubkey not admitted"
    };

    let user = match context.stores.users.find_by_pubkey(&event.pubkey).await {
        Ok(user) => user,
        Err(error) => {
            tracing::error!(error = %error, "user read failed; refusing the event");
            return Some(not_admitted_reason.to_owned());
        }
    };

    let Some(user) = user.filter(|user| user.is_admitted) else {
        return Some(not_admitted_reason.to_owned());
    };

    let min_balance = if payments_enabled {
        settings
            .limits
            .as_ref()
            .and_then(|limits| limits.event.as_ref())
            .and_then(|event| event.pubkey.as_ref())
            .map_or(0, |pubkey| pubkey.min_balance)
    } else {
        0
    };

    if min_balance > 0 && user.balance < min_balance {
        return Some("blocked: insufficient balance".to_owned());
    }

    None
}

/// `checkNip05Verification` (`:542-590`).
///
/// The background refresh `processNip05Metadata` fires for a kind-0 event is the NIP-05
/// verifier's (`nostream-services`); it has no wire effect, so it is not run here.
async fn check_nip05_verification(
    event: &Event,
    context: &HandlerContext,
    relay_public_key: &nostream_core::Pubkey,
) -> Option<String> {
    let settings = context.settings.nip05.as_ref()?;

    if settings.mode != nostream_config::settings::Nip05Mode::Enabled {
        return None;
    }

    if event.pubkey == *relay_public_key {
        return None;
    }

    if matches!(event.kind, Kind(28_934) | Kind(28_936) | SET_METADATA_KIND) {
        return None;
    }

    let verification = match context.stores.nip05.find_by_pubkey(&event.pubkey).await {
        Ok(verification) => verification,
        Err(error) => {
            tracing::error!(error = %error, "nip05 read failed; refusing the event");
            return Some("blocked: NIP-05 verification required".to_owned());
        }
    };

    let Some(verification) = verification else {
        return Some("blocked: NIP-05 verification required".to_owned());
    };

    if !nip05::is_domain_allowed(
        &verification.domain,
        settings.domain_whitelist.as_deref(),
        settings.domain_blacklist.as_deref(),
    ) {
        return Some("blocked: NIP-05 domain not allowed".to_owned());
    }

    let Some(last_verified_at) = verification.last_verified_at else {
        return Some("blocked: NIP-05 verification required".to_owned());
    };

    let expiration = settings
        .verify_expiration
        .map_or(nip05::DEFAULT_NIP05_VERIFY_EXPIRATION_MS, |value| {
            i64::try_from(value).unwrap_or(i64::MAX)
        });

    let elapsed = context
        .now_ms()
        .saturating_sub(u64::try_from(last_verified_at.timestamp_millis()).unwrap_or_default());

    if elapsed > u64::try_from(expiration).unwrap_or(u64::MAX) {
        return Some("blocked: NIP-05 verification expired".to_owned());
    }

    None
}

/// `ALL_RELAYS`, re-exported for the tests that build kind-62 events.
pub const ALL_RELAYS_TAG: &str = ALL_RELAYS;

/// `EventKinds.REACTION`, re-exported for the tests.
pub const REACTION: Kind = REACTION_KIND;
