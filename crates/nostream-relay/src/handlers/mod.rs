//! The five wire message handlers. Mirrors `src/handlers/*-message-handler.ts` at the
//! capture commit (the NIP-77 `neg-*` handlers are at the oracle, not here).
//!
//! Handlers never touch the transport: they receive a [`HandlerContext`], which carries the
//! write-point sink, the read-through settings, the clock, the connection state and the
//! repository seams.

//! [`begin`] runs a message's **ordering-sensitive prefix** on the caller's task — the
//! connection loop — before the loop reads the next frame, and returns the rest of the
//! handler as a future to spawn. The rule for which handler takes a prefix: it is the
//! per-connection state a later frame's handler reads and expects to be there. `subscribe`
//! registers its subscription and its read, `unsubscribe` clears them, and `auth` records the
//! session a restricted `REQ` is judged against, so those three are prefixes. `event` and
//! `count` keep their whole body as one future: neither establishes per-connection state that a
//! later frame looks up. What they do touch is not per-connection either — the event limiter's
//! key is the event's author and window in a table the whole relay shares
//! (`RateLimits::event_backoff`) — so two pipelined `EVENT`s from one author record their hits
//! in whichever order their tasks are polled, and which of the two is refused is not fixed by
//! arrival order. The capture races the same way: each `message` event starts an async handler
//! the adapter does not await (`web-socket-adapter.ts:79`, `:229`), so the two hits are
//! unordered there too.

pub mod auth;
pub mod count;
pub mod event;
pub mod subscribe;
pub mod unsubscribe;

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use tokio::sync::broadcast;

use nostream_config::settings::{Nip42Settings, Settings};
use nostream_core::adaptive_pow::AdaptivePowState;
use nostream_core::clock::Clock;
use nostream_core::messages::{ClosedMessage, CommandResult, NoticeMessage, RelayMessage};
use nostream_core::nip42;
use nostream_core::random::RandomSource;
use nostream_core::{Event, KindSelector, Pubkey};
use nostream_storage::repositories::{
    DvmJobRepository, EventRepository, InviteCodeRepository, Nip05VerificationRepository,
    ReportRepository, UserRepository,
};

use crate::connection::Connection;
use crate::hidden_content::HiddenContentCache;
use crate::limits::RateLimits;
use crate::relay_key::RelayKeySource;
use crate::sink::FrameSink;
use crate::wot::WotGraph;

/// The repository seams a handler may call. Every one is a trait object, so a test supplies
/// in-memory doubles and no handler knows which backend it has. Storage only: a service the
/// relay owns lives on the context beside `limits`.
pub struct Stores {
    pub events: Arc<dyn EventRepository>,
    pub users: Arc<dyn UserRepository>,
    pub nip05: Arc<dyn Nip05VerificationRepository>,
    pub invites: Arc<dyn InviteCodeRepository>,
    pub dvm_jobs: Arc<dyn DvmJobRepository>,
    pub reports: Arc<dyn ReportRepository>,
}

/// The context one socket shares across handlers (`src/@types/message-handlers.ts`).
///
/// `settings` is the loaded document, read through on every check (R27); `pow` is this
/// process's adaptive-difficulty sample, which the capture keeps as module state.
#[derive(Clone)]
pub struct HandlerContext {
    pub settings: Arc<Settings>,
    pub clock: Arc<dyn Clock>,
    /// The server's randomness: the challenge and an invite code (R29's fixture seam).
    pub random: Arc<dyn RandomSource>,
    pub sink: FrameSink,
    pub connection: Arc<Connection>,
    pub stores: Arc<Stores>,
    /// The trust graph `contact_list` and `report` reach for, best-effort. A service the relay
    /// owns rather than a store (`wot.rs`), held here beside `limits`.
    pub wot: Arc<dyn WotGraph>,
    pub limits: Arc<RateLimits>,
    pub hidden: Arc<HiddenContentCache>,
    pub keys: Arc<RelayKeySource>,
    pub broadcast: broadcast::Sender<std::sync::Arc<Event>>,
    pub pow: Arc<Mutex<AdaptivePowState>>,
}

impl HandlerContext {
    /// `Math.floor(Date.now() / 1000)`.
    pub fn now_secs(&self) -> i64 {
        self.clock.now_secs()
    }

    /// `Date.now()`.
    pub fn now_ms(&self) -> u64 {
        self.clock.now_ms()
    }

    /// `settings.info.relay_url`.
    pub fn relay_url(&self) -> &str {
        &self.settings.info.relay_url
    }

    /// The relay's own pubkey, when it has a signing key (`getRelayPublicKey`, which throws
    /// in the capture when there is none; every caller here treats `None` as "no key").
    pub fn relay_public_key(&self) -> Option<Pubkey> {
        self.keys.try_public_key(self.relay_url())
    }

    /// The live authenticated pubkeys for this socket.
    pub fn authenticated_pubkeys(&self) -> HashSet<Pubkey> {
        self.connection.authenticated_pubkeys(self.now_secs())
    }

    /// The restricted-read kinds this relay honours (`getRestrictedReadKinds`).
    pub fn restricted_read_kinds(&self) -> Vec<KindSelector> {
        restricted_read_kinds(self.settings.nip42.as_ref())
    }

    /// `createReadAuthorizationGuard` bound to this socket's authenticated set: the snapshot
    /// is taken when the guard is built, so a caller that wants the capture's per-event
    /// behaviour builds one per event (the stored read does; the live fan-out builds one per
    /// dispatch).
    pub fn read_authorization_guard(&self) -> ReadGuard {
        ReadGuard {
            restricted: self.restricted_read_kinds(),
            authenticated: self.authenticated_pubkeys(),
        }
    }

    /// `["OK", <id>, <accepted>, <message>]` with the optional backoff slot.
    pub fn send_ok(
        &self,
        event_id: nostream_core::EventId,
        accepted: bool,
        message: &str,
        params: Option<String>,
    ) {
        self.sink.send(&RelayMessage::Ok(CommandResult {
            event_id,
            accepted,
            message: message.to_owned(),
            params,
        }));
    }

    /// `["CLOSED", <id>, <message>]` with the optional backoff slot.
    pub fn send_closed(&self, subscription_id: &str, message: &str, params: Option<String>) {
        self.sink.send(&RelayMessage::Closed(ClosedMessage {
            subscription_id: subscription_id.to_owned(),
            message: message.to_owned(),
            params,
        }));
    }

    /// `["NOTICE", <message>]`.
    pub fn send_notice(&self, message: &str) {
        self.sink.send(&RelayMessage::Notice(NoticeMessage {
            message: message.to_owned(),
        }));
    }
}

/// One socket's read-authorisation decision (`createReadAuthorizationGuard`).
#[derive(Debug, Clone)]
pub struct ReadGuard {
    restricted: Vec<KindSelector>,
    authenticated: HashSet<Pubkey>,
}

impl ReadGuard {
    /// Whether this socket may read `event`.
    pub fn allows(&self, event: &Event) -> bool {
        nip42::is_read_authorized(event, &self.restricted, &self.authenticated)
    }
}

/// `getRestrictedReadKinds` (`src/utils/nip42.ts:17-24`): the configured kinds when
/// restricted reads are enabled, the NIP-42 defaults when no list is given, none when off.
pub fn restricted_read_kinds(settings: Option<&Nip42Settings>) -> Vec<KindSelector> {
    let Some(settings) = settings else {
        return Vec::new();
    };

    let enabled = settings
        .restricted_reads
        .as_ref()
        .is_some_and(|reads| reads.enabled);

    let configured: Vec<KindSelector> = settings
        .restricted_reads
        .as_ref()
        .and_then(|reads| reads.kinds.clone())
        .unwrap_or_default();

    nip42::restricted_read_kinds(enabled, &configured)
}

/// One handler's future, boxed so a connection task can spawn it without naming its type.
pub type HandlerFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Runs one decoded client message's ordering-sensitive prefix on the caller's task, as the
/// capture's `messageHandlerFactory` switch does, and returns the rest of its handler.
///
/// Nothing here can enforce when it is called: the guarantee holds because the connection loop
/// is the only caller in `src`, and it calls this before reading the next frame. For a message
/// with a prefix, every statement the prefix executes has run by the time this returns. `None`
/// means the prefix handled the message and nothing is left to run — it writes whatever frames
/// its handler writes, and `CLOSE` writes none; `Some(future)` is the rest of the handler, which
/// is spawned into the socket's handler set and runs unordered with its neighbours.
///
/// The postcondition is therefore about the prefix, not the handler: the `Event` and `Count`
/// arms box the whole handler, so none of their body is ordered.
pub fn begin(
    message: nostream_core::messages::ClientMessage,
    context: &Arc<HandlerContext>,
) -> Option<HandlerFuture> {
    use nostream_core::messages::ClientMessage;

    match message {
        ClientMessage::Event(event) => {
            let context = Arc::clone(context);

            // Whole body by rule: `event` needs no prefix (see the module doc).
            Some(Box::pin(
                async move { event::handle(event, &context).await },
            ))
        }
        ClientMessage::Count(message) => {
            let context = Arc::clone(context);

            // Whole body by rule: `count` needs no prefix (see the module doc).
            Some(Box::pin(
                async move { count::handle(message, &context).await },
            ))
        }
        ClientMessage::Subscribe(message) => subscribe::begin(message, context),
        ClientMessage::Unsubscribe(message) => {
            unsubscribe::handle(message, context);

            None
        }
        ClientMessage::Auth(message) => {
            auth::handle(message, context);

            None
        }
    }
}
