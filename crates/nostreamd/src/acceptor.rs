//! The acceptor: the bound listener and the one task that serves it.
//!
//! This is the Phase-1 runtime decision (ADR 0001): a **single acceptor task**, no
//! `SO_REUSEPORT`, no per-core acceptor sharding. The capture's model is a cluster primary
//! forking `cpus().length` client workers that all `listen()` the same port plus an IPC hop;
//! Phase 2 decides against or reproduces that fan-out on measurements.
//!
//! The accepted socket is handed to [`nostream_relay::Relay`], which upgrades it, runs its
//! per-socket state machine and drains it on shutdown — the acceptor no longer drops it.

use std::net::SocketAddr;
use std::sync::Arc;

use tokio::net::TcpListener;

use nostream_core::lifecycle::ShutdownState;
use nostream_relay::Relay;

use crate::error::DaemonError;

/// The acceptor's handle.
#[derive(Debug)]
pub struct Acceptor {
    listener: TcpListener,
    local_addr: SocketAddr,
}

impl Acceptor {
    /// Binds the listener on `addr`.
    pub async fn bind(addr: SocketAddr) -> Result<Self, DaemonError> {
        let listener = TcpListener::bind(addr)
            .await
            .map_err(|error| DaemonError::Setup(format!("bind {addr}: {error}")))?;
        let local_addr = listener
            .local_addr()
            .map_err(|error| DaemonError::Setup(format!("local_addr: {error}")))?;
        Ok(Self {
            listener,
            local_addr,
        })
    }

    /// The bound address (an ephemeral port resolves to the real one).
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Serves the listener through `relay` until `shutdown` fires, then drains.
    ///
    /// `Relay::serve` owns the accept loop so the socket never leaves the relay's hands: it
    /// upgrades each accepted stream, spawns its connection task and waits out the drain
    /// timeout (`web-socket-server-adapter.ts:67-95`). The handover is recorded in ADR 0004
    /// (against spec R1's "the acceptor hands the accepted socket to the relay"): the drain
    /// deadline and the `JoinSet` it waits on are one decision, so both live where the
    /// sockets are served.
    pub async fn run(self, relay: Arc<Relay>, shutdown: ShutdownState) {
        tracing::debug!(at = %self.local_addr, "the relay takes the listener");

        relay.serve(self.listener, shutdown).await;
    }
}
