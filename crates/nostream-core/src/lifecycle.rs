//! Process lifecycle: the shared drain flag. Mirrors `src/utils/shutdown-state.ts`.
//!
//! One `ShutdownState` is created by the composition root and cloned into the acceptor and
//! any future connection handler. `begin_draining` is idempotent; `wait_for_drain` resolves
//! as soon as the flag is set and never misses a drain that starts while it waits.

use tokio::sync::watch;

/// The shared graceful-drain flag (`src/utils/shutdown-state.ts` `beginDraining`/`isDraining`).
#[derive(Debug, Clone)]
pub struct ShutdownState {
    sender: watch::Sender<bool>,
}

impl Default for ShutdownState {
    fn default() -> Self {
        Self::new()
    }
}

impl ShutdownState {
    /// Creates a state that is not draining.
    pub fn new() -> Self {
        let (sender, _receiver) = watch::channel(false);
        Self { sender }
    }

    /// Marks the process as draining. Safe to call more than once.
    pub fn begin_draining(&self) {
        let _ = self.sender.send(true);
    }

    /// Whether draining has begun.
    pub fn is_draining(&self) -> bool {
        *self.sender.borrow()
    }

    /// A receiver for the drain flag, for tasks that select on it.
    pub fn watch(&self) -> watch::Receiver<bool> {
        self.sender.subscribe()
    }

    /// Resolves once `begin_draining` has been called (immediately if it already has).
    pub async fn wait_for_drain(&self) {
        let mut receiver = self.sender.subscribe();
        while !*receiver.borrow_and_update() {
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}
