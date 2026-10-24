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
//!
//! **The queue is bounded in bytes**, which the capture does not do: it queues every frame
//! and never pushes back (`src/utils/stream.ts:11-18`), so a stored read of large events can
//! grow the process without limit while a socket drains at link speed. Here a frame is
//! admitted only while the queued bytes stay within the bound the sink was built with, and a
//! frame larger than the bound is still admitted into an empty queue so one big event does
//! not close every client. A frame that does not fit is dropped, the sink records the
//! overflow and warns once with the bound and the depth, and every later send is dropped
//! without queueing. The connection task reads the flag and closes the client with 1013, so
//! the policy is a disconnect rather than a silent break (ADR 0005).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use tokio::sync::mpsc;

use nostream_core::messages::RelayMessage;

/// A handle to one connection's outbound frame queue.
#[derive(Debug, Clone)]
pub struct FrameSink {
    sender: Option<mpsc::UnboundedSender<String>>,
    /// The byte bound the queue was built with.
    bound_bytes: usize,
    /// The bytes admitted and not yet released, shared with the draining clone.
    queued_bytes: Arc<AtomicUsize>,
    /// Set once a frame was dropped for the bound: from then on every send is dropped.
    overflowed: Arc<AtomicBool>,
}

impl FrameSink {
    /// Creates the queue and its sink, admitting at most `bound_bytes` of queued frames. The
    /// receiver is drained by the connection task, which [`FrameSink::release`]s each frame's
    /// bytes once its write completes.
    pub fn channel(bound_bytes: usize) -> (Self, mpsc::UnboundedReceiver<String>) {
        let (sender, receiver) = mpsc::unbounded_channel();

        (
            Self {
                sender: Some(sender),
                bound_bytes,
                queued_bytes: Arc::new(AtomicUsize::new(0)),
                overflowed: Arc::new(AtomicBool::new(false)),
            },
            receiver,
        )
    }

    /// A sink that is already closed: every send is dropped silently. Used by tests that
    /// assert the "not open" behaviour without a socket.
    pub fn closed() -> Self {
        Self {
            sender: None,
            bound_bytes: 0,
            queued_bytes: Arc::new(AtomicUsize::new(0)),
            overflowed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Sends one frame. A closed socket drops the frame and is not an error.
    pub fn send(&self, message: &RelayMessage) {
        let Some(sender) = &self.sender else {
            return;
        };

        if self.overflowed.load(Ordering::SeqCst) {
            return;
        }

        let text = message.to_text();
        let length = text.len();
        let queued = self.queued_bytes.load(Ordering::SeqCst);

        // An empty queue admits its frame whatever the size, so an event larger than the
        // whole bound still reaches the client instead of closing it.
        if queued > 0 && queued + length > self.bound_bytes {
            self.overflowed.store(true, Ordering::SeqCst);
            tracing::warn!(
                bound_bytes = self.bound_bytes,
                queued_bytes = queued,
                "outbound frame queue full: dropping frames and closing the client"
            );
            return;
        }

        self.queued_bytes.store(queued + length, Ordering::SeqCst);

        // The receiver is gone exactly when the connection task ended: the socket is not
        // open, and the capture's guard returns without sending.
        let _ = sender.send(text);
    }

    /// Releases a frame's bytes once it has been written to the socket.
    pub(crate) fn release(&self, bytes: usize) {
        let _ = self
            .queued_bytes
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |queued| {
                Some(queued.saturating_sub(bytes))
            });
    }

    /// Whether a frame has been dropped for the bound. The connection task closes the client
    /// once this is set.
    pub fn overflowed(&self) -> bool {
        self.overflowed.load(Ordering::SeqCst)
    }

    /// The bytes admitted into the queue and not yet written.
    pub fn queued_bytes(&self) -> usize {
        self.queued_bytes.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostream_core::messages::NoticeMessage;

    fn notice(message: &str) -> RelayMessage {
        RelayMessage::Notice(NoticeMessage {
            message: message.to_owned(),
        })
    }

    #[test]
    fn the_queue_is_bounded_in_bytes_and_reports_the_overflow() {
        let frame = notice("bounded");
        let len = frame.to_text().len();

        // Two frames fit exactly, and a third is dropped rather than queued.
        let (sink, mut frames) = FrameSink::channel(2 * len);

        sink.send(&frame);
        sink.send(&frame);

        assert!(!sink.overflowed());
        assert_eq!(sink.queued_bytes(), 2 * len);
        assert!(frames.try_recv().is_ok());
        assert!(frames.try_recv().is_ok());
        assert!(frames.try_recv().is_err());

        sink.send(&frame);

        assert!(sink.overflowed());
        assert_eq!(
            sink.queued_bytes(),
            2 * len,
            "the dropped frame is not counted"
        );
        assert!(
            frames.try_recv().is_err(),
            "the dropped frame was never queued"
        );

        // Once the flag is set every later send is dropped as well.
        sink.send(&frame);

        assert!(sink.overflowed());
        assert_eq!(sink.queued_bytes(), 2 * len);

        // A frame larger than the bound still goes out while the queue is empty, so one
        // large event does not close every client.
        let (sink, mut frames) = FrameSink::channel(len - 1);

        sink.send(&frame);

        assert!(!sink.overflowed());
        assert_eq!(sink.queued_bytes(), len);
        assert!(frames.try_recv().is_ok());

        sink.send(&frame);

        assert!(sink.overflowed());
        assert_eq!(sink.queued_bytes(), len);
        assert!(frames.try_recv().is_err());
    }
}
