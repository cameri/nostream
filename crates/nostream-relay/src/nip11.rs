//! The NIP-11 relay information document: every key's presence decided here.
//!
//! Mirrors the capture's one object literal
//! (`src/handlers/request-handlers/root-request-handler.ts:116-210`), audited field by field
//! at `docs/rewrite/nip-parity.md:717-767`, with the field-set verdicts recorded in ADR 0016
//! D4. Nothing serves it: `nostream-cli info` builds its own payload and the HTTP surface is
//! still shut (D1), so this module is the builder a surface will adopt, not a route.
//! `info` keeps its own assembly because its output is pinned byte for byte and carries no
//! document, so sharing this builder would buy it nothing and put the pin at risk.
//!
//! The rule behind the drops is the audit's: advertise what the relay enforces.
//! `max_filters` and `max_filter_values` stay because `subscribe.rs` and `count.rs` check
//! them; `min_prefix` and `max_event_tags` go because nothing does; `supported_nip_extensions`,
//! `supported_mips` and `fees.subscription` have no Rust source at all, and `payments_url` and
//! `peering` name surfaces this relay does not serve.

use nostream_config::settings::{ContentLimitsOrVec, FeeSchedule, Settings};
use nostream_core::Pubkey;
use nostream_core::constants::SUPPORTED_NIPS;
use nostream_storage::DEFAULT_PAGE_ROWS;
use serde::Serialize;

use crate::error::RelayError;

/// The NIP-11 document, in the capture's key order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RelayInformationDocument {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub pubkey: String,
    /// The key the relay signs with, for NIP-43 clients: the published status document's
    /// `relayPubkey`, and absent when no fresh document names one.
    #[serde(rename = "self", skip_serializing_if = "Option::is_none")]
    pub self_: Option<String>,
    pub contact: String,
    pub supported_nips: Vec<u16>,
    pub software: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terms_of_service: Option<String>,
    pub limitation: Limitation,
    pub fees: Fees,
}

/// The `limitation` block: the bounds this relay enforces, and nothing it does not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Limitation {
    /// `nostream_relay::transport::max_payload_size`: the number the websocket enforces.
    pub max_message_length: u64,
    /// `limits.client.subscription.*`; a configured `0` means "no cap" to the checks that
    /// read it, so it is omitted rather than advertised as "none allowed".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_subscriptions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_filters: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_filter_values: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_subid_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_content_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_pow_difficulty: Option<u64>,
    /// The capture's deliberate split: `auth_required` means AUTH before any action, and this
    /// relay only gates publishes (`nip42.authRequired`, advertised as `restricted_writes`).
    pub auth_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at_lower_limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at_upper_limit: Option<i64>,
    /// The page a limit-less read materialises in both backends.
    pub default_limit: u64,
    pub restricted_writes: bool,
    pub search_supported: bool,
}

/// The `fees` block: the enabled fee schedules, in msats. `publication` is omitted when the
/// settings omit it; `admission` is always an array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Fees {
    pub admission: Vec<Fee>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication: Option<Vec<Fee>>,
}

/// One fee entry (`{ amount, unit }`, the capture's shape).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Fee {
    pub amount: i64,
    pub unit: String,
}

/// The document for these settings, this version and the identity the published document names.
///
/// `relay_pubkey` is the only source of `self`: with no fresh status document there is no
/// identity, and a settings value or the answering process's environment would be a key the
/// relay may not sign with (R11).
pub fn document(
    settings: &Settings,
    version: &str,
    relay_pubkey: Option<Pubkey>,
) -> RelayInformationDocument {
    let info = &settings.info;

    RelayInformationDocument {
        name: info.name.clone(),
        description: info.description.clone(),
        banner: info.banner.clone(),
        icon: info.icon.clone(),
        pubkey: hex_or_written(&info.pubkey),
        self_: relay_pubkey.map(|pubkey| pubkey.to_string()),
        contact: info.contact.clone(),
        supported_nips: supported_nips(settings),
        software: env!("CARGO_PKG_REPOSITORY").to_owned(),
        version: version.to_owned(),
        terms_of_service: info.terms_of_service.clone(),
        limitation: limitation(settings),
        fees: fees(settings),
    }
}

/// `hasWriteRestriction`: the arms the event handler enforces, and no others.
///
/// The capture's subscription arm is not ported — nothing in the rewrite enforces
/// subscriptions, so a configured plan does not make this true.
pub fn restricted_writes(settings: &Settings) -> bool {
    let payments = settings
        .payments
        .as_ref()
        .filter(|payments| payments.enabled);
    let admission_fee = payments.is_some_and(|payments| {
        payments
            .fee_schedules
            .admission
            .iter()
            .any(|schedule| schedule.enabled)
    });
    let nip43 = settings.nip43.as_ref().is_some_and(|nip43| nip43.enabled);
    let auth_required = settings
        .nip42
        .as_ref()
        .and_then(|nip42| nip42.auth_required)
        .unwrap_or(false);

    let event = settings
        .limits
        .as_ref()
        .and_then(|limits| limits.event.as_ref());
    let event_id_bits = event
        .and_then(|event| event.event_id.as_ref())
        .and_then(|event_id| event_id.min_leading_zero_bits)
        .unwrap_or(0);
    let pubkey_bits = event
        .and_then(|event| event.pubkey.as_ref())
        .map_or(0, |pubkey| pubkey.min_leading_zero_bits);
    let pow = event
        .and_then(|event| event.pow.as_ref())
        .is_some_and(|pow| pow.enabled);
    let pubkeys_listed = event
        .and_then(|event| event.pubkey.as_ref())
        .is_some_and(|pubkey| {
            pubkey
                .whitelist
                .as_ref()
                .is_some_and(|list| !list.is_empty())
                || pubkey
                    .blacklist
                    .as_ref()
                    .is_some_and(|list| !list.is_empty())
        });
    let kinds_listed = event
        .and_then(|event| event.kind.as_ref())
        .is_some_and(|kind| {
            kind.whitelist.as_ref().is_some_and(|list| !list.is_empty())
                || kind.blacklist.as_ref().is_some_and(|list| !list.is_empty())
        });

    admission_fee
        || nip43
        || auth_required
        || event_id_bits > 0
        || pubkey_bits > 0
        || pow
        || pubkeys_listed
        || kinds_listed
}

/// `parseRelayPubkey`: 64 hex characters lowercased, an `npub1…` decoded, anything else
/// nothing, and an `npub` that does not decode an error.
pub fn parse_relay_pubkey(value: Option<&str>) -> Result<Option<Pubkey>, RelayError> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return parse_hex(value).map(Some);
    }

    if value.to_lowercase().starts_with("npub1") {
        let hex = nostream_core::nip19::decode_npub_hex(value).map_err(|error| {
            RelayError::Configuration(format!(
                "info.self npub did not decode to a 32-byte pubkey: {error}"
            ))
        })?;

        return parse_hex(&hex).map(Some);
    }

    Ok(None)
}

fn parse_hex(value: &str) -> Result<Pubkey, RelayError> {
    value
        .to_lowercase()
        .parse::<Pubkey>()
        .map_err(|error| RelayError::Configuration(error.to_string()))
}

/// `info.pubkey` as the document carries it: hex lowercased, an `npub` decoded, and a value
/// that is neither left exactly as written (the capture's `rawPubkey`).
fn hex_or_written(value: &str) -> String {
    match parse_relay_pubkey(Some(value)) {
        Ok(Some(pubkey)) => pubkey.to_string(),
        _ => value.to_owned(),
    }
}

/// `SUPPORTED_NIPS` in its own order, minus what does not run: 43 without NIP-43 enabled, 50
/// without NIP-50 enabled, and 77 always (its handler is a stub).
fn supported_nips(settings: &Settings) -> Vec<u16> {
    let nip43 = settings.nip43.as_ref().is_some_and(|nip43| nip43.enabled);
    let nip50 = settings
        .nip50
        .as_ref()
        .and_then(|nip50| nip50.enabled)
        .unwrap_or(false);

    SUPPORTED_NIPS
        .iter()
        .copied()
        .filter(|nip| *nip != 77 && (*nip != 43 || nip43) && (*nip != 50 || nip50))
        .collect()
}

fn limitation(settings: &Settings) -> Limitation {
    let event = settings
        .limits
        .as_ref()
        .and_then(|limits| limits.event.as_ref());
    let subscription = settings
        .limits
        .as_ref()
        .and_then(|limits| limits.client.as_ref())
        .and_then(|client| client.subscription.as_ref());

    // The document answers the enforced derivation at a zero rate and no distance — the lowest
    // difficulty any client may be accepted at (`handlers::event::required_difficulty`).
    let required = crate::handlers::event::required_difficulty(event, 0.0, None);

    Limitation {
        max_message_length: u64::try_from(crate::transport::max_payload_size(settings))
            .unwrap_or(u64::MAX),
        max_subscriptions: configured(subscription.and_then(|limits| limits.max_subscriptions)),
        max_filters: configured(subscription.and_then(|limits| limits.max_filters)),
        max_filter_values: configured(subscription.and_then(|limits| limits.max_filter_values)),
        max_limit: configured(subscription.and_then(|limits| limits.max_limit)),
        max_subid_length: configured(
            subscription.and_then(|limits| limits.max_subscription_id_length),
        ),
        max_content_length: content_length(event.and_then(|event| event.content.as_ref())),
        min_pow_difficulty: (required > 0).then_some(u64::from(required)),
        auth_required: false,
        payment_required: settings.payments.as_ref().map(|payments| payments.enabled),
        created_at_lower_limit: event
            .and_then(|event| event.created_at.as_ref())
            .and_then(|created_at| created_at.max_negative_delta),
        created_at_upper_limit: event
            .and_then(|event| event.created_at.as_ref())
            .and_then(|created_at| created_at.max_positive_delta),
        default_limit: DEFAULT_PAGE_ROWS,
        restricted_writes: restricted_writes(settings),
        search_supported: settings
            .nip50
            .as_ref()
            .and_then(|nip50| nip50.enabled)
            .unwrap_or(false),
    }
}

/// A configured client limit; `0` means "no cap" to the checks that read it, so it is omitted.
fn configured(limit: Option<u64>) -> Option<u64> {
    limit.filter(|limit| *limit > 0)
}

/// A list of content rules yields its first entry's bound, the capture's own rule.
fn content_length(content: Option<&ContentLimitsOrVec>) -> Option<u64> {
    match content? {
        ContentLimitsOrVec::One(limit) => limit.max_length,
        ContentLimitsOrVec::Many(limits) => limits.first().and_then(|limit| limit.max_length),
    }
}

/// The enabled fee schedules, and only while payments are on — the predicate the admission
/// check applies.
fn fees(settings: &Settings) -> Fees {
    let Some(payments) = settings
        .payments
        .as_ref()
        .filter(|payments| payments.enabled)
    else {
        return Fees {
            admission: Vec::new(),
            publication: None,
        };
    };

    Fees {
        admission: schedule_fees(&payments.fee_schedules.admission),
        publication: payments
            .fee_schedules
            .publication
            .as_deref()
            .map(schedule_fees),
    }
}

fn schedule_fees(schedules: &[FeeSchedule]) -> Vec<Fee> {
    schedules
        .iter()
        .filter(|schedule| schedule.enabled)
        .map(|schedule| Fee {
            amount: schedule.amount,
            unit: "msats".to_owned(),
        })
        .collect()
}
