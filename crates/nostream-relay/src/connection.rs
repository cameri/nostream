//! Per-connection state: the subscription table, the NIP-42 session, the in-flight reads
//! and the socket's identity. Mirrors `src/@types/{subscription,clients}.ts`, the
//! subscription half of `src/adapters/web-socket-adapter.ts`, and
//! `src/utils/nip42-session.ts`.
//!
//! One task per socket owns the transport; the [`Connection`] is shared with the handlers
//! that task runs, because a `CLOSE` and a live dispatch both need the table while a read
//! is in flight (`web-socket-adapter.ts:312-335`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use nostream_config::settings::Settings;
use nostream_core::nip42::Nip42Session;
use nostream_core::random::RandomSource;
use nostream_core::{Event, Filter, Pubkey};

use crate::error::RelayError;
use crate::sink::FrameSink;

/// The socket the acceptor hands over: a negotiated websocket over the accepted TCP stream.
pub type AcceptedTransport = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// One registered subscription (`src/@types/subscription.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    pub id: String,
    pub filters: Vec<Filter>,
}

/// A connected client: what it subscribed to, who it authenticated as, and which reads are
/// running.
#[derive(Debug)]
pub struct Connection {
    /// `<addr>` in every rate-limit bucket key (`A11`: the TCP peer).
    pub remote_address: String,
    subscriptions: Mutex<HashMap<String, Subscription>>,
    session: Mutex<Nip42Session>,
    in_flight: Mutex<InFlightReads>,
}

/// The reads running on one socket, each owned by the generation it was given.
///
/// A re-`REQ` replaces the read for its id and signals the old one to abort; the old read
/// then returns through [`Connection::end_read`] carrying the generation it began with, and
/// that call must not remove its replacement's entry. The counter is connection-wide and
/// never reset, so a generation is unique for the socket's life and a fresh read under an
/// id an aborted read is still winding down from cannot be handed the same number (ADR
/// 0005).
#[derive(Debug, Default)]
struct InFlightReads {
    /// The generation the next read is given.
    next_generation: u64,
    /// The live read per subscription id, with the generation that owns the entry.
    by_subscription: HashMap<String, (u64, watch::Sender<bool>)>,
}

/// One read's ownership of its entry in the in-flight table: the subscription it streams,
/// the generation that owns the entry, and the cancellation signal it watches.
///
/// It is passed to [`Connection::end_read`] as the read's last act, so ending a read is
/// something a read can do exactly once and only to its own entry.
#[derive(Debug)]
pub struct InFlightRead {
    subscription_id: String,
    generation: u64,
    cancellation: watch::Receiver<bool>,
}

impl InFlightRead {
    /// The subscription this read streams.
    pub fn subscription_id(&self) -> &str {
        &self.subscription_id
    }

    /// The cancellation signal: `true` once this read has been aborted.
    pub fn cancellation(&mut self) -> &mut watch::Receiver<bool> {
        &mut self.cancellation
    }
}

impl Connection {
    /// Accepts one upgraded socket: mints this socket's NIP-42 challenge, sends it, and
    /// returns the state (`WebSocketAdapter`'s constructor, `:110-123`).
    pub fn accept(
        transport: &AcceptedTransport,
        context: &ConnectionContext,
    ) -> Result<Self, RelayError> {
        let remote_address = match transport.get_ref().peer_addr() {
            Ok(address) => address.ip().to_string(),
            Err(error) => {
                tracing::debug!(error = %error, "accepted socket has no peer address");
                String::new()
            }
        };

        let ttl_seconds = context
            .settings
            .nip42
            .as_ref()
            .and_then(|nipp42| nipp42.session_expiry_seconds)
            .unwrap_or(0);

        let session = Nip42Session::from_random(ttl_seconds, context.random.as_ref())
            .map_err(|error| RelayError::Configuration(error.to_string()))?;

        context
            .sink
            .send(&nostream_core::messages::RelayMessage::Auth(
                nostream_core::messages::AuthChallengeMessage {
                    challenge: session.challenge().to_owned(),
                },
            ));

        Ok(Self::new(remote_address, session))
    }

    /// The per-socket state, with no socket: the shape [`Connection::accept`] builds and the
    /// one tests build directly.
    pub fn new(remote_address: String, session: Nip42Session) -> Self {
        Self {
            remote_address,
            subscriptions: Mutex::new(HashMap::new()),
            session: Mutex::new(session),
            in_flight: Mutex::new(InFlightReads::default()),
        }
    }

    /// Registers or replaces one subscription (`onSubscribed`).
    pub fn subscribe(&self, subscription: Subscription) {
        self.subscriptions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(subscription.id.clone(), subscription);
    }

    /// Removes one subscription (`onUnsubscribed`), returning it when it existed.
    pub fn unsubscribe(&self, id: &str) -> Option<Subscription> {
        self.subscriptions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id)
    }

    /// Every registered subscription, in id order, which is the order a drain writes its
    /// `CLOSED` frames in.
    pub fn subscriptions(&self) -> Vec<Subscription> {
        let mut subscriptions: Vec<Subscription> = self
            .subscriptions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect();

        subscriptions.sort_by(|left, right| left.id.cmp(&right.id));

        subscriptions
    }

    /// How many subscriptions are registered.
    pub fn subscription_count(&self) -> usize {
        self.subscriptions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    /// The registered filters for one id.
    pub fn subscription(&self, id: &str) -> Option<Subscription> {
        self.subscriptions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
    }

    /// Whether `filters` is exactly the filter set registered under `id`
    /// (`canSubscribe`'s duplicate check).
    pub fn has_identical_subscription(&self, id: &str, filters: &[Filter]) -> bool {
        self.subscription(id).is_some_and(|subscription| {
            !subscription.filters.is_empty() && subscription.filters == filters
        })
    }

    /// The subscription ids whose filters match `event`, in id order (`onSendEvent`).
    pub fn matching_subscription_ids(&self, event: &Event) -> Vec<String> {
        let mut matches: Vec<String> = self
            .subscriptions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .filter(|subscription| {
                subscription
                    .filters
                    .iter()
                    .any(|filter| filter.matches(event))
            })
            .map(|subscription| subscription.id.clone())
            .collect();

        matches.sort();

        matches
    }

    /// This socket's NIP-42 challenge (`getChallenge`).
    pub fn challenge(&self) -> String {
        self.session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .challenge()
            .to_owned()
    }

    /// The live authenticated pubkeys (`getAuthenticatedPubkeys`).
    pub fn authenticated_pubkeys(&self, now: i64) -> HashSet<Pubkey> {
        self.session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .authenticated_pubkeys(now)
    }

    /// The live authenticated pubkeys in stable order (`[...getAuthenticatedPubkeys()]`).
    pub fn authenticated_pubkeys_in_order(&self, now: i64) -> Vec<Pubkey> {
        self.session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .authenticated_pubkeys_in_order(now)
    }

    /// Records a successful AUTH, `false` on replay (`addAuthenticatedPubkey`).
    pub fn authenticate(
        &self,
        pubkey: Pubkey,
        auth_event_id: nostream_core::EventId,
        now: i64,
    ) -> bool {
        self.session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .authenticate(pubkey, auth_event_id, now)
    }

    /// Starts an abortable read for `subscription_id` and returns the read's handle.
    ///
    /// A previous read for the same id is aborted first, so a re-REQ cannot leave two
    /// streams writing to one subscription (`onClientMessage` replaces the handler). The
    /// new read is given the next generation, which is what makes
    /// [`Connection::end_read`] remove only its own entry.
    pub fn begin_read(&self, subscription_id: &str) -> InFlightRead {
        let (sender, cancellation) = watch::channel(false);
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let generation = in_flight.next_generation;
        // A generation is unique for the socket's life; the wrap is unreachable, and a
        // panic on it would be a panic in the accept path.
        in_flight.next_generation = in_flight.next_generation.wrapping_add(1);

        if let Some((_, previous)) = in_flight
            .by_subscription
            .insert(subscription_id.to_owned(), (generation, sender))
        {
            let _ = previous.send(true);
        }

        InFlightRead {
            subscription_id: subscription_id.to_owned(),
            generation,
            cancellation,
        }
    }

    /// Ends a read without aborting it (the stream finished).
    ///
    /// The entry is removed only while `read`'s generation still owns it: a read that a
    /// re-`REQ` replaced has nothing left to remove, and leaving the replacement's entry
    /// alone is what keeps the replacement streaming to its `EOSE`.
    pub fn end_read(&self, read: InFlightRead) {
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let owns_entry = in_flight
            .by_subscription
            .get(read.subscription_id())
            .map(|(generation, _)| *generation)
            == Some(read.generation);

        if owns_entry {
            in_flight.by_subscription.remove(read.subscription_id());
        }
    }

    /// Aborts the read running for `subscription_id`, if any (`abortInFlightSubscriptionReads`).
    pub fn abort_read(&self, subscription_id: &str) {
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if let Some((_, sender)) = in_flight.by_subscription.remove(subscription_id) {
            let _ = sender.send(true);
        }
    }

    /// Whether a read is running for `subscription_id`.
    pub fn read_in_flight(&self, subscription_id: &str) -> bool {
        self.in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .by_subscription
            .contains_key(subscription_id)
    }

    /// Connection close (`onClientClose`): clears the subscription table and the auth
    /// session, and aborts every in-flight read.
    pub fn close(&self) {
        self.subscriptions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();

        self.session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();

        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        for (_, (_, sender)) in in_flight.by_subscription.drain() {
            let _ = sender.send(true);
        }
    }
}

/// The state a connection is accepted with: the settings it reads through, the randomness its
/// challenge is minted from, and the sink the challenge leaves through.
pub struct ConnectionContext {
    pub settings: Arc<Settings>,
    pub random: Arc<dyn RandomSource>,
    pub sink: FrameSink,
}

/// One negentropy session (oracle `041fe34e`; no session file exists at this branch's capture).
#[derive(Debug, Clone, Default)]
pub struct NegentropySession {
    pub subscription_id: Option<String>,
    pub frame_size: u64,
}

/// Accepts an open negentropy session for a connection.
///
/// Phase 2 stub — job 011; will track the set-reconciliation state; the capture commit this
/// branch ports from has no NIP-77 handler (`src/utils/negentropy-sessions.ts` first appears
/// at `041fe34e`), so a NIP-77 job must be cut against that tree; see
/// `src/utils/negentropy-sessions.ts`.
pub fn open_negentropy_session(_session: NegentropySession) -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::connection::open_negentropy_session",
    })
}
