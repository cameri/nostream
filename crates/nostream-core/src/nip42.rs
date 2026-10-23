//! NIP-42: authentication of clients to relays. Mirrors `src/utils/nip42.ts` and
//! `src/utils/nip42-session.ts`.
//!
//! [`authenticate`] is the pure check of one kind-22242 event against the connection's
//! challenge and the relay's URL; [`Nip42Session`] is the per-connection state — one
//! challenge, the accepted pubkeys with their authentication instant, the accepted AUTH
//! event ids, and the optional TTL. The read-authorisation guards are here too, because
//! `src/utils/nip42.ts` owns them and `nostream-relay` only wires them.

use std::collections::{BTreeMap, HashSet};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use crate::error::CoreError;
use crate::event::{Event, EventId, Kind, KindSelector, Pubkey};
use crate::filter::Filter;

/// The kinds a client may only read as their author or a p-tagged recipient
/// (`DEFAULT_RESTRICTED_READ_KINDS`, `src/utils/nip42.ts:10-13`): kind 4 and kind 1059.
pub const DEFAULT_RESTRICTED_READ_KINDS: [Kind; 2] = [Kind(4), Kind(1059)];

/// `AUTH_EVENT_KIND` (`src/handlers/auth-message-handler.ts:19`).
pub const AUTH_EVENT_KIND: Kind = Kind(22_242);

/// `MAX_TIMESTAMP_DELTA_SECONDS` (`src/handlers/auth-message-handler.ts:20`).
pub const MAX_TIMESTAMP_DELTA_SECONDS: i64 = 600;

/// Why an AUTH event failed. Each variant carries the capture's reason text, without the
/// `invalid: ` prefix the handler adds (`src/handlers/auth-message-handler.ts:27-62`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthFailure {
    /// `invalid: auth event must be kind 22242`
    WrongKind,
    /// `invalid: event id does not match`
    IdMismatch,
    /// `invalid: event signature verification failed`
    SignatureInvalid,
    /// `invalid: created_at is too far from the current time`
    TimestampTooFar,
    /// `invalid: challenge does not match`
    ChallengeMismatch,
    /// `invalid: relay url does not match`
    RelayMismatch,
}

impl AuthFailure {
    /// The capture's reason text, after `invalid: `.
    pub fn message(self) -> &'static str {
        match self {
            Self::WrongKind => "auth event must be kind 22242",
            Self::IdMismatch => "event id does not match",
            Self::SignatureInvalid => "event signature verification failed",
            Self::TimestampTooFar => "created_at is too far from the current time",
            Self::ChallengeMismatch => "challenge does not match",
            Self::RelayMismatch => "relay url does not match",
        }
    }
}

/// Checks that a kind-22242 event answers this challenge and is signed by its author.
///
/// The checks run in `AuthMessageHandler.handleMessage`'s order (`:25-62`): kind, id,
/// signature, the ±600 s window, the `challenge` tag, the `relay` tag's hostname. `now` is
/// supplied by the caller because no module reads the system clock
/// ([`crate::messages`] is pure; the relay owns the clock).
pub fn authenticate(
    event: &Event,
    challenge: &str,
    relay_url: &str,
    now: i64,
) -> Result<Pubkey, AuthFailure> {
    if event.kind != AUTH_EVENT_KIND {
        return Err(AuthFailure::WrongKind);
    }

    let id = crate::crypto::compute_event_id(event).map_err(|_| AuthFailure::IdMismatch)?;

    if id != event.id {
        return Err(AuthFailure::IdMismatch);
    }

    crate::crypto::verify_event_signature(event).map_err(|_| AuthFailure::SignatureInvalid)?;

    if (now - event.created_at).abs() > MAX_TIMESTAMP_DELTA_SECONDS {
        return Err(AuthFailure::TimestampTooFar);
    }

    let challenge_tag = event
        .tags
        .iter()
        .find(|tag| tag.len() >= 2 && tag[0] == "challenge");

    if !challenge_tag.is_some_and(|tag| tag[1] == challenge) {
        return Err(AuthFailure::ChallengeMismatch);
    }

    let relay_tag = event
        .tags
        .iter()
        .find(|tag| tag.len() >= 2 && tag[0] == "relay");

    if !relay_tag.is_some_and(|tag| is_relay_url_match(&tag[1], relay_url)) {
        return Err(AuthFailure::RelayMismatch);
    }

    Ok(event.pubkey)
}

/// NIP-42 says domain-match is sufficient (`isRelayUrlMatch`,
/// `src/handlers/auth-message-handler.ts:81-89`): the hostnames, lowercased, must be equal
/// and both URLs must parse.
pub fn is_relay_url_match(client_relay: &str, server_relay: &str) -> bool {
    let hostname = |value: &str| {
        url::Url::parse(value)
            .ok()
            .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
    };

    match (hostname(client_relay), hostname(server_relay)) {
        (Some(client), Some(server)) => client == server,
        _ => false,
    }
}

/// Generates a fresh challenge for a connection: 32 OS-random bytes, base64url without
/// padding (`Nip42SessionManager.createChallenge`, `src/utils/nip42-session.ts:29-31`).
pub fn generate_challenge() -> Result<String, CoreError> {
    let mut bytes = [0u8; 32];

    getrandom::fill(&mut bytes)
        .map_err(|error| CoreError::InvalidMessage(format!("challenge entropy: {error}")))?;

    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// The per-connection NIP-42 state (`Nip42SessionManager`, `src/utils/nip42-session.ts`).
///
/// One challenge per socket, never rotated by AUTH; accepted AUTH event ids are remembered so
/// a replay cannot refresh the session; a pubkey's session expires when
/// `now - authenticatedAt >= ttl`, and `ttl` of zero or less never expires.
#[derive(Debug, Clone)]
pub struct Nip42Session {
    challenge: String,
    ttl_seconds: i64,
    sessions: BTreeMap<Pubkey, i64>,
    accepted_auth_event_ids: HashSet<EventId>,
}

impl Nip42Session {
    /// Mints the connection's challenge. `ttl_seconds` is `nip42.sessionExpirySeconds`,
    /// where `0` means no expiry.
    pub fn new(ttl_seconds: i64) -> Result<Self, CoreError> {
        Ok(Self {
            challenge: generate_challenge()?,
            ttl_seconds,
            sessions: BTreeMap::new(),
            accepted_auth_event_ids: HashSet::new(),
        })
    }

    /// The state for a challenge the caller already has. The differential fixture replays a
    /// recorded session, so its challenge must be the recording's, not fresh entropy.
    pub fn with_challenge(challenge: impl Into<String>, ttl_seconds: i64) -> Self {
        Self {
            challenge: challenge.into(),
            ttl_seconds,
            sessions: BTreeMap::new(),
            accepted_auth_event_ids: HashSet::new(),
        }
    }

    /// The connection's challenge, for the `["AUTH", …]` frame and the AUTH handler.
    pub fn challenge(&self) -> &str {
        &self.challenge
    }

    /// Records a successful AUTH. Returns `false` when this AUTH event id was already
    /// accepted on this socket (a replay).
    pub fn authenticate(&mut self, pubkey: Pubkey, auth_event_id: EventId, now: i64) -> bool {
        if !self.accepted_auth_event_ids.insert(auth_event_id) {
            return false;
        }

        self.sessions.insert(pubkey, now);
        true
    }

    /// Clears the whole session (connection close).
    pub fn clear(&mut self) {
        self.sessions.clear();
        self.accepted_auth_event_ids.clear();
    }

    /// The live pubkeys, after pruning expired sessions.
    pub fn authenticated_pubkeys(&mut self, now: i64) -> HashSet<Pubkey> {
        self.prune_expired(now);
        self.sessions.keys().copied().collect()
    }

    /// The live pubkeys in stable (pubkey) order, after pruning expired sessions. The
    /// capture's `[...set]` yields insertion order; a whitelist pick needs *an* order, and
    /// this one cannot vary between runs.
    pub fn authenticated_pubkeys_in_order(&mut self, now: i64) -> Vec<Pubkey> {
        self.prune_expired(now);
        self.sessions.keys().copied().collect()
    }

    /// Whether one pubkey is authenticated, after pruning expired sessions.
    pub fn is_authenticated(&mut self, pubkey: &Pubkey, now: i64) -> bool {
        self.prune_expired(now);
        self.sessions.contains_key(pubkey)
    }

    /// The instant a pubkey authenticated at, after pruning expired sessions.
    pub fn authenticated_at(&mut self, pubkey: &Pubkey, now: i64) -> Option<i64> {
        self.prune_expired(now);
        self.sessions.get(pubkey).copied()
    }

    fn prune_expired(&mut self, now: i64) {
        if self.ttl_seconds <= 0 {
            return;
        }

        self.sessions
            .retain(|_, authenticated_at| now - *authenticated_at < self.ttl_seconds);
    }
}

/// `getRestrictedReadKinds`: the configured kinds when restricted reads are enabled, the
/// NIP-42 defaults otherwise, and none when the feature is off entirely.
pub fn restricted_read_kinds(enabled: bool, configured: &[KindSelector]) -> Vec<KindSelector> {
    if !enabled {
        return Vec::new();
    }

    if configured.is_empty() {
        DEFAULT_RESTRICTED_READ_KINDS
            .iter()
            .map(|kind| KindSelector::Single(*kind))
            .collect()
    } else {
        configured.to_vec()
    }
}

/// `isEventKindOrRangeMatch` for a restricted-read selector.
fn covers(selector: KindSelector, kind: Kind) -> bool {
    match selector {
        KindSelector::Single(candidate) => candidate == kind,
        KindSelector::Range([first, last]) => kind >= first && kind <= last,
    }
}

/// `isClientAuthorizedToReadMention` (`src/utils/nip42.ts:29-41`): the event's author or a
/// pubkey named by one of its `p` tags must be authenticated.
pub fn is_client_authorized_to_read_mention(
    event: &Event,
    authenticated: &HashSet<Pubkey>,
) -> bool {
    if authenticated.is_empty() {
        return false;
    }

    if authenticated.contains(&event.pubkey) {
        return true;
    }

    event.tags.iter().any(|tag| {
        tag.len() >= 2
            && tag[0] == "p"
            && tag[1]
                .parse::<Pubkey>()
                .is_ok_and(|pubkey| authenticated.contains(&pubkey))
    })
}

/// `createReadAuthorizationGuard` (`src/utils/nip42.ts:44-58`): unrestricted events pass;
/// a restricted event needs author or p-tag authorisation.
pub fn is_read_authorized(
    event: &Event,
    restricted_kinds: &[KindSelector],
    authenticated: &HashSet<Pubkey>,
) -> bool {
    if !restricted_kinds
        .iter()
        .any(|selector| covers(*selector, event.kind))
    {
        return true;
    }

    is_client_authorized_to_read_mention(event, authenticated)
}

/// `isSubscriptionAuthRequired` (`src/utils/nip42.ts:71-91`): a REQ whose every filter asks
/// only for restricted kinds can return nothing to an unauthenticated client, so it is
/// closed with `auth-required` instead of served empty.
pub fn is_subscription_auth_required(
    restricted_kinds: &[KindSelector],
    filters: &[Filter],
    authenticated: &HashSet<Pubkey>,
) -> bool {
    if restricted_kinds.is_empty() {
        return false;
    }

    let is_fully_restricted = |filter: &Filter| {
        filter.kinds.as_ref().is_some_and(|kinds| {
            !kinds.is_empty()
                && kinds.iter().all(|kind| {
                    restricted_kinds
                        .iter()
                        .any(|selector| covers(*selector, *kind))
                })
        })
    };

    if filters.is_empty() || !filters.iter().all(is_fully_restricted) {
        return false;
    }

    authenticated.is_empty()
}

/// `isCountAuthorized` (`src/utils/nip42.ts:94-115`): a COUNT for restricted kinds must be
/// scoped to the client's own `authors` or `#p` values.
pub fn is_count_authorized(
    restricted_kinds: &[KindSelector],
    filters: &[Filter],
    authenticated: &HashSet<Pubkey>,
) -> bool {
    if restricted_kinds.is_empty() {
        return true;
    }

    let restricted_filters: Vec<&Filter> = filters
        .iter()
        .filter(|filter| {
            filter.kinds.as_ref().is_some_and(|kinds| {
                kinds.iter().any(|kind| {
                    restricted_kinds
                        .iter()
                        .any(|selector| covers(*selector, *kind))
                })
            })
        })
        .collect();

    if restricted_filters.is_empty() {
        return true;
    }

    let is_scoped_to_client = |values: Option<&Vec<String>>| {
        values.is_some_and(|values| {
            !values.is_empty()
                && values.iter().all(|value| {
                    value
                        .parse::<Pubkey>()
                        .is_ok_and(|pubkey| authenticated.contains(&pubkey))
                })
        })
    };

    restricted_filters.iter().all(|filter| {
        is_scoped_to_client(filter.authors.as_ref()) || is_scoped_to_client(filter.tags.get("#p"))
    })
}
