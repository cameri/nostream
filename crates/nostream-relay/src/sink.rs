//! The one write point for server→client frames. Mirrors `WebSocketAdapter.sendMessage`
//! (`src/adapters/web-socket-adapter.ts:150-155`).
//!
//! Every JSON frame the relay sends — handler replies, subscription reads, live dispatch, the
//! NIP-42 challenge — goes through [`FrameSink`]. Handlers and strategies hold a sink and
//! never touch the transport; the connection task is the only writer, and it encodes through
//! [`RelayMessage::to_text`], so frame encoding happens in one place.
//!
//! Two writes deliberately skip the queue, and both are in the connection task that drains
//! it: the drain's `CLOSED` frames go straight to the socket because the loop that would
//! drain the queue is the one being left, and the liveness `Ping` is a control frame rather
//! than JSON.
//!
//! A send on a socket that is no longer open is dropped silently, which is what the
//! capture's `readyState !== OPEN` guard does: it returns without an error.

use tokio::sync::mpsc;

use nostream_core::messages::RelayMessage;

/// A handle to one connection's outbound frame queue.
#[derive(Debug, Clone)]
pub struct FrameSink {
    sender: Option<mpsc::UnboundedSender<String>>,
}

impl FrameSink {
    /// A sink whose frames go to `sender`.
    pub fn new(sender: mpsc::UnboundedSender<String>) -> Self {
        Self {
            sender: Some(sender),
        }
    }

    /// Creates the queue and its sink. The receiver is drained by the connection task.
    pub fn channel() -> (Self, mpsc::UnboundedReceiver<String>) {
        let (sender, receiver) = mpsc::unbounded_channel();

        (Self::new(sender), receiver)
    }

    /// A sink that is already closed: every send is dropped silently. Used by tests that
    /// assert the "not open" behaviour without a socket.
    pub fn closed() -> Self {
        Self { sender: None }
    }

    /// Sends one frame. A closed socket drops the frame and is not an error.
    pub fn send(&self, message: &RelayMessage) {
        let Some(sender) = &self.sender else {
            return;
        };

        // The receiver is gone exactly when the connection task ended: the socket is not
        // open, and the capture's guard returns without sending.
        let _ = sender.send(message.to_text());
    }
}
