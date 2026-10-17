//! Per-connection state. Mirrors `src/@types/{subscription,clients}.ts` and the auth/session
//! half of `src/utils/nip42-session.ts`.

use std::collections::HashMap;

use nostream_core::{Filter, Pubkey};

use crate::error::RelayError;

/// One registered subscription (`src/@types/subscription.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    pub id: String,
    pub filters: Vec<Filter>,
}

/// A connected client and what it may read (`src/@types/clients.ts`).
#[derive(Debug, Clone, Default)]
pub struct Connection {
    pub pubkey: Option<Pubkey>,
    pub subscriptions: HashMap<String, Subscription>,
    pub is_authenticated: bool,
}

impl Connection {
    /// Accepts one upgraded socket into the relay's connection table.
    ///
    /// Phase 1 stub — job 005; will register the socket, apply connection limits and send the
    /// NIP-42 challenge; see `src/adapters/web-socket-adapter.ts`. The accepted transport and
    /// the shared handler context arrive together because registration, limits and the
    /// challenge all read the context — a bare address cannot be registered, limited or
    /// challenged, and Phase 2's transport type is decided with the WebSocket dependency.
    pub async fn accept(
        _transport: crate::connection::AcceptedTransport,
        _context: crate::handlers::HandlerContext,
    ) -> Result<Self, RelayError> {
        Err(RelayError::NotImplemented {
            module: "relay::connection::Connection::accept",
        })
    }

    /// Registers or replaces one subscription.
    ///
    /// Phase 1 stub — job 005; will enforce the client subscription limits; see `src/utils/filter.ts`.
    pub fn subscribe(&mut self, _subscription: Subscription) -> Result<(), RelayError> {
        Err(RelayError::NotImplemented {
            module: "relay::connection::Connection::subscribe",
        })
    }
}

/// The transport the acceptor hands over. Phase 1 pins the seam, not the socket type: the
/// WebSocket dependency (and with it the real transport) is a Phase-2 decision, so this is
/// an opaque placeholder the stub signatures can name.
#[derive(Debug, Clone, Default)]
pub struct AcceptedTransport;

/// One negentropy session (oracle `041fe34e`; no session file exists at this branch's capture).
#[derive(Debug, Clone, Default)]
pub struct NegentropySession {
    pub subscription_id: Option<String>,
    pub frame_size: u64,
}

/// Accepts an open negentropy session for a connection.
///
/// Phase 1 stub — job 005; will track the set-reconciliation state; see `src/utils/negentropy-sessions.ts`.
pub fn open_negentropy_session(_session: NegentropySession) -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::connection::open_negentropy_session",
    })
}
