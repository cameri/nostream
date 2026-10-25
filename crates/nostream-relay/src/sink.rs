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
//! overflow and each racing sender that sets the flag warns once with the bound and the
//! depth — one line per sender, not one per connection — and every later send is dropped
//! without queueing. The connection task reads the flag and closes the client with 1013, so
//! the policy is a disconnect rather than a silent break (ADR 0005).
//!
//! **The sum is bounded too**, which the per-socket bound cannot do: one address that opens
//! sockets and stops reading held a multiple of the per-socket bound, so every socket's
//! queue is also counted against one process-wide [`FrameBudget`] (ADR 0008). An admission
//! needs room in both bounds; the budget has no empty-queue exception, so a frame that does
//! not fit the budget is refused however empty its own queue. The socket's share of the
//! budget is refunded when its last sink handle drops — see [`Account`] — because the next
//! socket's admission depends on it.

use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicU64, AtomicUsize, Ordering};

use tokio::sync::mpsc;

use nostream_core::messages::RelayMessage;

/// Why a frame was refused: the bound that could not hold it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The frame did not fit this socket's `frame_queue_bytes`.
    QueueFull,
    /// The frame did not fit the relay's `frame_memory_budget_bytes`.
    BudgetExhausted,
}

/// No refusal recorded yet; the two values below are this file's only refusal causes.
const NO_REFUSAL: u8 = 0;
const QUEUE_FULL: u8 = 1;
const BUDGET_EXHAUSTED: u8 = 2;

/// The process-wide bound on queued outbound payload bytes, shared by every socket of one
/// relay (ADR 0008).
///
/// The unit is `text.len()`, the same bytes `frame_queue_bytes` counts: not `String`
/// capacity, and not resident memory.
#[derive(Debug)]
pub struct FrameBudget {
    limit_bytes: usize,
    accounted_bytes: AtomicUsize,
    refusals: AtomicU64,
}

impl FrameBudget {
    /// A budget of `limit_bytes`, with nothing accounted.
    pub fn new(limit_bytes: usize) -> Self {
        Self {
            limit_bytes,
            accounted_bytes: AtomicUsize::new(0),
            refusals: AtomicU64::new(0),
        }
    }

    /// The byte bound.
    pub fn limit(&self) -> usize {
        self.limit_bytes
    }

    /// The bytes admitted across every socket and not yet written or refunded.
    pub fn accounted(&self) -> usize {
        self.accounted_bytes.load(Ordering::SeqCst)
    }

    /// How many sockets were refused because their frame did not fit.
    pub fn refusals(&self) -> u64 {
        self.refusals.load(Ordering::SeqCst)
    }

    /// Admits `bytes` against the budget, or reports that they do not fit.
    ///
    /// A compare-and-exchange loop for the same reason [`FrameSink::send`] uses one: every
    /// handler of every socket shares this counter, and a load-then-store would lose an
    /// increment and admit more than the budget.
    fn admit(&self, bytes: usize) -> bool {
        let mut accounted = self.accounted_bytes.load(Ordering::SeqCst);

        loop {
            // Strict: the whole frame has to fit what is left, with no exception for an
            // empty budget — unlike the per-socket bound, whose exception keeps one large
            // event from closing every client.
            if bytes > self.limit_bytes.saturating_sub(accounted) {
                return false;
            }

            match self.accounted_bytes.compare_exchange_weak(
                accounted,
                accounted + bytes,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return true,
                Err(actual) => accounted = actual,
            }
        }
    }

    /// Returns bytes to the budget: a written frame's, or a closing socket's remainder.
    fn release(&self, bytes: usize) {
        let _ = self
            .accounted_bytes
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |accounted| {
                Some(accounted.saturating_sub(bytes))
            });
    }

    /// Counts one socket refused for the budget.
    fn refuse(&self) {
        self.refusals.fetch_add(1, Ordering::SeqCst);
    }
}

/// One socket's accounting: the bytes it has admitted, its refusal cause, and the budget
/// those bytes are counted against when the relay has one.
///
/// Every clone of the socket's sink shares this value, so the `Drop` that runs here is the
/// socket's accounting ending: a send holds a sink and therefore cannot be in flight or
/// begin once the drop starts. That is what makes the refund exactly this socket's
/// outstanding bytes, once, on every exit from the connection loop — the drain arm's
/// [`FrameSink::release`] keeps handling the bytes it wrote on the way out.
#[derive(Debug)]
struct Account {
    queued_bytes: AtomicUsize,
    refusal: AtomicU8,
    budget: Option<Arc<FrameBudget>>,
}

impl Account {
    /// The refusal recorded for this socket, if a sender has been refused.
    fn refusal(&self) -> Option<Refusal> {
        match self.refusal.load(Ordering::SeqCst) {
            QUEUE_FULL => Some(Refusal::QueueFull),
            BUDGET_EXHAUSTED => Some(Refusal::BudgetExhausted),
            _ => None,
        }
    }

    /// Records the first refusal for this socket, reporting whether this sender set it.
    fn refuse(&self, refusal: Refusal) -> bool {
        let cause = match refusal {
            Refusal::QueueFull => QUEUE_FULL,
            Refusal::BudgetExhausted => BUDGET_EXHAUSTED,
        };

        self.refusal
            .compare_exchange(NO_REFUSAL, cause, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

impl Drop for Account {
    fn drop(&mut self) {
        if let Some(budget) = &self.budget {
            budget.release(self.queued_bytes.load(Ordering::SeqCst));
        }
    }
}

/// A handle to one connection's outbound frame queue.
#[derive(Debug, Clone)]
pub struct FrameSink {
    sender: Option<mpsc::UnboundedSender<String>>,
    /// The byte bound the queue was built with.
    bound_bytes: usize,
    /// The socket's accounting, shared with every clone and with the draining task.
    account: Arc<Account>,
}

impl FrameSink {
    /// Creates the queue and its sink, admitting at most `bound_bytes` of queued frames.
    ///
    /// `budget` is the relay's process-wide bound, shared by every socket it serves: a frame
    /// has to fit both. The receiver is drained by the connection task, which
    /// [`FrameSink::release`]s each frame's bytes once its write completes.
    pub fn channel(
        bound_bytes: usize,
        budget: Option<Arc<FrameBudget>>,
    ) -> (Self, mpsc::UnboundedReceiver<String>) {
        let (sender, receiver) = mpsc::unbounded_channel();

        (
            Self {
                sender: Some(sender),
                bound_bytes,
                account: Arc::new(Account {
                    queued_bytes: AtomicUsize::new(0),
                    refusal: AtomicU8::new(NO_REFUSAL),
                    budget,
                }),
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
            account: Arc::new(Account {
                queued_bytes: AtomicUsize::new(0),
                refusal: AtomicU8::new(NO_REFUSAL),
                budget: None,
            }),
        }
    }

    /// Sends one frame. A closed socket drops the frame and is not an error.
    ///
    /// A queue-full refusal latches the socket shut, as the overflow always has: every later
    /// send is dropped. A budget refusal does not — it is one frame that did not fit at that
    /// instant, and the connection task closes the socket at its next iteration whatever the
    /// sender does — so the accounting stays exact and a frame that fits later is admitted.
    pub fn send(&self, message: &RelayMessage) {
        let Some(sender) = &self.sender else {
            return;
        };

        let text = message.to_text();
        let length = text.len();
        let mut queued = self.account.queued_bytes.load(Ordering::SeqCst);

        // Admission is a compare-and-exchange, not a load-then-store: an in-flight read runs
        // in its own task and several readers share this sink, so two sends that interleaved
        // a load and a store would lose one increment and admit more than the bound.
        loop {
            if self.account.refusal() == Some(Refusal::QueueFull) {
                return;
            }
            // An empty queue admits its frame whatever the size, so an event larger than the
            // whole bound still reaches the client instead of closing it.
            if queued > 0 && queued + length > self.bound_bytes {
                self.account.refuse(Refusal::QueueFull);
                tracing::warn!(
                    bound_bytes = self.bound_bytes,
                    queued_bytes = queued,
                    "outbound frame queue full: dropping frames and closing the client"
                );
                return;
            }

            match self.account.queued_bytes.compare_exchange_weak(
                queued,
                queued + length,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                // Another sender got in first: judge the bound against what it left.
                Err(actual) => queued = actual,
            }
        }

        // The budget comes second so a socket that is already over its own bound refuses for
        // that reason, as it did before this counter existed. It has no empty-queue
        // exception: a frame that does not fit the budget is refused even on an idle socket.
        if let Some(budget) = &self.account.budget
            && !budget.admit(length)
        {
            // The frame is never queued, so the bytes counted a moment ago will never be
            // released by the drain arm: take them back here, exactly what was counted.
            let _ = self.account.queued_bytes.try_update(
                Ordering::SeqCst,
                Ordering::SeqCst,
                |queued| Some(queued.saturating_sub(length)),
            );

            if self.account.refuse(Refusal::BudgetExhausted) {
                budget.refuse();
                tracing::warn!(
                    budget_bytes = budget.limit(),
                    accounted_bytes = budget.accounted(),
                    "frame memory budget exhausted: dropping frames and closing the client"
                );
            }

            return;
        }

        // The receiver is gone exactly when the connection task ended: the socket is not
        // open, and the capture's guard returns without sending.
        let _ = sender.send(text);
    }

    /// Releases a frame's bytes once it has been written to the socket, for this socket and
    /// for the budget it counts against.
    pub(crate) fn release(&self, bytes: usize) {
        let _ =
            self.account
                .queued_bytes
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |queued| {
                    Some(queued.saturating_sub(bytes))
                });

        if let Some(budget) = &self.account.budget {
            budget.release(bytes);
        }
    }

    /// Why a frame was refused, if the connection is over its bound. The connection task
    /// closes the client once this is set.
    pub fn refusal(&self) -> Option<Refusal> {
        self.account.refusal()
    }

    /// The bytes admitted into the queue and not yet written.
    pub fn queued_bytes(&self) -> usize {
        self.account.queued_bytes.load(Ordering::SeqCst)
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
        let (sink, mut frames) = FrameSink::channel(2 * len, None);

        sink.send(&frame);
        sink.send(&frame);

        assert_eq!(sink.refusal(), None);
        assert_eq!(sink.queued_bytes(), 2 * len);
        assert!(frames.try_recv().is_ok());
        assert!(frames.try_recv().is_ok());
        assert!(frames.try_recv().is_err());

        sink.send(&frame);

        assert_eq!(sink.refusal(), Some(Refusal::QueueFull));
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

        assert_eq!(sink.refusal(), Some(Refusal::QueueFull));
        assert_eq!(sink.queued_bytes(), 2 * len);

        // A frame larger than the bound still goes out while the queue is empty, so one
        // large event does not close every client.
        let (sink, mut frames) = FrameSink::channel(len - 1, None);

        sink.send(&frame);

        assert_eq!(sink.refusal(), None);
        assert_eq!(sink.queued_bytes(), len);
        assert!(frames.try_recv().is_ok());

        sink.send(&frame);

        assert_eq!(sink.refusal(), Some(Refusal::QueueFull));
        assert_eq!(sink.queued_bytes(), len);
        assert!(frames.try_recv().is_err());

        // Several in-flight reads share one sink, so the accounting has to survive concurrent
        // senders: every frame fits the bound and every frame's bytes are counted once. The
        // barrier makes the sends overlap but cannot force the interleaving a lost update
        // needs, so this is a regression guard rather than a proof.
        const SENDERS: usize = 8;

        let (sink, mut frames) = FrameSink::channel(SENDERS * len, None);
        let start = std::sync::Barrier::new(SENDERS);

        std::thread::scope(|scope| {
            for _ in 0..SENDERS {
                let sink = sink.clone();
                let frame = &frame;
                let start = &start;

                scope.spawn(move || {
                    start.wait();
                    sink.send(frame);
                });
            }
        });

        assert_eq!(sink.refusal(), None, "every frame fits the bound");
        assert_eq!(sink.queued_bytes(), SENDERS * len);

        for _ in 0..SENDERS {
            assert!(frames.try_recv().is_ok());
        }

        assert!(frames.try_recv().is_err());

        // `release` is the drain side's half of the balance: bytes come back as a frame is
        // written, so a drained queue admits again and the count never drifts upwards.
        let (sink, mut frames) = FrameSink::channel(2 * len, None);

        sink.send(&frame);
        sink.send(&frame);
        sink.release(2 * len);

        assert_eq!(sink.queued_bytes(), 0);
        assert_eq!(sink.refusal(), None);

        sink.send(&frame);
        sink.send(&frame);

        assert_eq!(sink.queued_bytes(), 2 * len);
        assert!(frames.try_recv().is_ok());
        assert!(frames.try_recv().is_ok());
        assert!(frames.try_recv().is_ok());
        assert!(frames.try_recv().is_ok());
        assert!(frames.try_recv().is_err());
    }

    #[test]
    fn the_budget_binds_across_sockets_and_is_shared() {
        let frame = notice("shared");
        let len = frame.to_text().len();
        let budget = Arc::new(FrameBudget::new(2 * len));

        // Three sockets of a relay whose budget only two frames of this size fit in.
        let (first, _first_frames) = FrameSink::channel(4 * len, Some(Arc::clone(&budget)));
        let (second, _second_frames) = FrameSink::channel(4 * len, Some(Arc::clone(&budget)));
        let (third, mut third_frames) = FrameSink::channel(4 * len, Some(Arc::clone(&budget)));

        first.send(&frame);
        second.send(&frame);

        assert_eq!(budget.accounted(), budget.limit());
        assert!(budget.accounted() <= budget.limit());

        third.send(&frame);

        assert_eq!(third.refusal(), Some(Refusal::BudgetExhausted));
        assert_eq!(
            third.queued_bytes(),
            0,
            "a refused frame is not counted against the socket either"
        );
        assert_eq!(
            budget.accounted(),
            2 * len,
            "the refused frame is not accounted"
        );
        assert_eq!(budget.refusals(), 1);
        assert!(third_frames.try_recv().is_err());
        assert!(budget.accounted() <= budget.limit());

        // The drain arm returning one written frame's bytes is all the room a waiting socket
        // needs: the bound is bytes, not a queue slot.
        first.release(len);

        third.send(&frame);

        assert_eq!(budget.accounted(), 2 * len);
        assert_eq!(
            budget.refusals(),
            1,
            "the second frame needed no second refusal"
        );
        assert_eq!(third.queued_bytes(), len);
        assert!(third_frames.try_recv().is_ok());
        assert!(budget.accounted() <= budget.limit());
    }

    #[test]
    fn the_budget_release_refunds_only_the_closing_sockets_bytes() {
        let frame = notice("refunded");
        let len = frame.to_text().len();
        let budget = Arc::new(FrameBudget::new(4 * len));

        let (first, _first_frames) = FrameSink::channel(len, Some(Arc::clone(&budget)));
        let (second, _second_frames) = FrameSink::channel(len, Some(Arc::clone(&budget)));

        first.send(&frame);
        second.send(&frame);

        assert_eq!(budget.accounted(), 2 * len);
        assert_eq!(first.queued_bytes(), len);
        assert_eq!(second.queued_bytes(), len);

        // Neither frame is released: this is the state of every exit from the connection loop
        // except the drain arm, where the frames a socket admitted were never written.
        drop(first);

        assert_eq!(
            budget.accounted(),
            len,
            "the refund is the closing socket's bytes, not the whole counter"
        );

        drop(second);

        assert_eq!(budget.accounted(), 0);

        // Both handles are gone and nothing underflowed: the budget still admits what it
        // should, which a race that subtracted the same bytes twice could not.
        let (third, mut third_frames) = FrameSink::channel(len, Some(Arc::clone(&budget)));

        third.send(&frame);

        assert_eq!(third.refusal(), None);
        assert_eq!(budget.accounted(), len);
        assert!(third_frames.try_recv().is_ok());
    }

    #[test]
    fn the_budget_is_never_over_committed_by_racing_senders() {
        // The shape of the racing-sender guard above: a barrier makes the sends overlap but
        // cannot force the interleaving a lost update needs, so this is a regression guard
        // rather than a proof.
        let frame = notice("raced");
        let len = frame.to_text().len();
        const SENDERS: usize = 8;
        let budget = Arc::new(FrameBudget::new(SENDERS * len));
        let max_seen = AtomicUsize::new(0);
        let start = std::sync::Barrier::new(SENDERS + 1);

        let mut sinks = Vec::new();

        for _ in 0..SENDERS {
            sinks.push(FrameSink::channel(len, Some(Arc::clone(&budget))).0);
        }

        std::thread::scope(|scope| {
            for sink in &sinks {
                let frame = &frame;
                let start = &start;

                scope.spawn(move || {
                    start.wait();
                    sink.send(frame);
                });
            }

            // A sampler reading the counter while the sends run: it stops when the budget is
            // full, so it cannot outlive the sends it observes.
            {
                let budget = Arc::clone(&budget);
                let max_seen = &max_seen;
                let start = &start;

                scope.spawn(move || {
                    start.wait();

                    loop {
                        let accounted = budget.accounted();
                        max_seen.fetch_max(accounted, Ordering::SeqCst);

                        if accounted == SENDERS * len {
                            break;
                        }

                        std::hint::spin_loop();
                    }
                });
            }
        });

        assert!(max_seen.load(Ordering::SeqCst) <= budget.limit());
        assert_eq!(
            budget.accounted(),
            SENDERS * len,
            "every frame was admitted once"
        );
        assert_eq!(budget.refusals(), 0);

        for sink in &sinks {
            assert_eq!(sink.queued_bytes(), len);
        }

        drop(sinks);

        assert_eq!(budget.accounted(), 0);
    }
}
