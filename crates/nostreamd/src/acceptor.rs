//! The acceptor: one task owning the listener, accepting sockets, handing each to the relay.
//!
//! This is the Phase-1 runtime decision (ADR 0001): a **single acceptor task**, no
//! `SO_REUSEPORT`, no per-core acceptor sharding — the TS relay is a single Node process, and
//! the multi-worker fan-out is a Phase-2 decision to take against measurements, not upfront.

use std::net::SocketAddr;

use tokio::net::TcpListener;
use tokio::sync::watch;

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

    /// Accepts sockets until `shutdown` fires; every socket is dropped with a debug line in
    /// Phase 1 — the relay wire takes the socket in Phase 2.
    pub async fn run(&self, mut shutdown: watch::Receiver<bool>) -> Result<(), DaemonError> {
        loop {
            let shutting_down = *shutdown.borrow();
            if shutting_down {
                tracing::debug!(at = %self.local_addr, "drained; the acceptor stops accepting");
                return Ok(());
            }

            let (socket, peer) = tokio::select! {
                accepted = self.listener.accept() => match accepted {
                    Ok(pair) => pair,
                    Err(error) => {
                        tracing::warn!(error = %error, "accept failed");
                        continue;
                    }
                },
                _ = shutdown.changed() => {
                    tracing::debug!(at = %self.local_addr, "drained; the acceptor stops accepting");
                    return Ok(());
                }
            };

            drop(socket);
            tracing::debug!(%peer, "accepted a socket; the relay wire is Phase 2, dropping it");
        }
    }
}
