# ADR 0005: Connection concurrency — read ownership, a bounded frame queue, and liveness under a blocked write (job 010)

- **Status:** accepted (job 010, Phase 2)
- **Deciders:** the rewrite team, on the evidence in job 010's recon and spec
- **Date:** 2026-10-24

## Context

One task per socket owns the transport, and three of its concurrent relationships were
wrong. A re-`REQ` replaces the read registered for a subscription id and aborts the old
one, and the old read's own cleanup then removed the *replacement's* cancellation sender,
so a re-subscribed client could go silent without an `EOSE`. A `CLOSE` that landed while
the NIP-43 invite mint was in flight aborted nothing, because the read was registered only
after that mint returned, so the handler streamed a stored read the client had already
closed. And the outbound frame queue was an unbounded channel whose only consumer was the
same select loop that performs the socket write, so a client that stopped reading let the
queue grow without limit while the liveness probe could not run.

Each fix had more than one plausible shape. This ADR records the shape chosen, the shape
rejected, and why — the code shows the first and cannot show the second.

## Read ownership — a connection-wide generation, not a token

The in-flight table records an owner with each entry: one mutex over a connection-wide
`next_generation: u64` and a map from subscription id to `(generation, watch::Sender)`.
`begin_read` hands back a handle carrying its id, its generation and the receiver;
`end_read` takes the handle by value and removes the entry only while the stored
generation still matches, so a replaced read's last act is a no-op and the replacement
keeps its sender. `abort_read`, `read_in_flight` and `close` keep their present
signatures and behaviour.

The generation is a counter and not a per-read token because tokio's `watch` handles
implement no equality at all — a sender or receiver can only be compared through the
crate's own `same_channel`, and only against another handle of the same kind. A read
would therefore have to present a value the table can compare, which means either a
`u64` or a freshly allocated `Arc<()>`; only the counter allocates nothing. It also fits
the locking the file already has: `impl Connection` contains no `.await`, so no lock is
ever held across a suspension point, and the counter is read and written inside the same
`insert` that replaces the previous sender. No second lock, no allocation outside the
guard, and no new state for a caller to keep.

The counter is connection-wide and never reset, rather than derived per id from the
previous entry. `abort_read` removes an entry for a read that is still winding down, so a
per-id "previous + 1" would restart at one and hand a fresh read the same number as the
aborted one — the defect again, one call later. Wrapping is unreachable (2^64 reads on one
socket) and is written with `wrapping_add` rather than a panic, because a panic there
would be a panic in the accept path.

The alternative shape — a guard owning the entry and releasing it on `Drop` — was
rejected as larger for the same property: it changes the call sites and the lifetime of
the cancel signal, and gives nothing the generation does not, since a read already has
exactly one point where it ends.

## The outbound frame queue — a byte bound and a disconnect, not a pause

`FrameSink` counts the bytes it has admitted and drops a frame that would exceed its
bound, unless the queue is empty, so one frame larger than the whole bound still reaches
the client instead of closing every client on a large event. A dropped frame sets an
overflow flag and logs one warning carrying the bound and the current depth; once the flag
is set every later send is dropped without queueing. The draining side releases a frame's
bytes when its write completes. The default bound is 8 MiB, which is above any single
outbound frame and a few hundred times below the 405 MiB an unbounded queue reached when
200 000 frames were queued with nothing draining.

The full-queue policy is **disconnect**: the connection loop closes the client with 1013
and the fixed reason `slow consumer: outbound frame queue full`, then falls through to the
existing cleanup. Three alternatives lost:

- **Pause the producer** (a bounded channel and a permit the sender waits for). It is a
  self-deadlock here: `FrameSink::send` is synchronous and `dispatch_live` — which sends to
  every matching subscription — is called from the very loop that drains the queue, so a
  permit wait on that path waits on the task that would release it. Working around it
  needs a second write path, which ADR 0004 forbids: one function turns a frame into
  outbound bytes. And it would not fix liveness on its own; the same write timeout below
  would still be needed, so it is more change for the same answer.
- **Silent break** (the shape the liveness path uses for a missed pong). The client cannot
  tell a slow link from a relay that forgot it, and a test cannot tell a policy from a
  crash. A close frame with a code and a reason is observable to both.
- **A reader task and a writer task per socket.** A larger restructuring of the connection
  loop and the drain for the same liveness bound the write timeout gives for a fraction of
  the diff; it also moves the send half of the socket out of the task that owns the
  connection's state, which every handler's sink would have to follow.

The bound and the timeout are `RelayConfig` fields and not settings. The capture has no
counterpart for either — it queues every frame without a limit
(`src/adapters/web-socket-adapter.ts:150-155`; its pipeline never pushes back,
`src/utils/stream.ts:11-18`) and its heartbeat is a process-wide interval — so a settings
key would be an operator-facing surface mirroring nothing. `RelayConfig` is where this
branch already keeps knobs the capture fixes in code and tests shorten.

## Liveness under a blocked write — every write carries a timeout

The write happens inside the select arm, so while it is pending the same task cannot poll
the liveness tick, the next inbound frame, the live-event ring or the drain flag. A
blocked write therefore starves the probe that exists to notice a dead client; an
inbound-only probe cannot help, because a client that stops reading is exactly a client
whose socket accepts nothing.

Every write the connection task performs — a queued frame, the pong reply, the liveness
ping, each `CLOSED` frame and the close frame in the drain — is wrapped in
`tokio::time::timeout(config.write_timeout, ..)`, and a write that elapses ends the
connection. The decision is that a write unable to complete within `write_timeout` is
itself evidence that the client is not reading, so waiting for the liveness arm would only
delay the same outcome. The default is 30 s against the capture's 120 s liveness interval:
shorter, so the write path ends a stuck client before a missed pong could, and long enough
for a large frame on a slow link. Because no select arm can stay pending longer than that
timeout, the tick can be delayed by at most 30 s, which is the interval's own order of
magnitude rather than the unbounded stall it was.

The overflow flag is read at the top of every loop iteration. No `await` sits between a
write returning and that check, so a flag a producer set while the loop was parked is acted
on as soon as the write completes.

## The invite emit stays unguarded

The read is registered before the invite mint's only `await`, and its cancellation is
checked before the stored read opens, so a `CLOSE` that lands during the mint ends the
subscription with no stored event and no `EOSE`. The invite `EVENT` is nonetheless still
emitted for that closed subscription. That is deliberate parity, not an oversight: the
capture emits the invite event unguarded
(`src/handlers/subscribe-message-handler.ts:111`) and attaches its abort signal only to the
stored read (`:230`), while it sets the abortable subscription id as the handler's first
statement (`:53`). The TypeScript tree wins where the two trees disagree absent a decision
record, so the fix must not reach for the emit; the exposure it leaves is one stray
`EVENT`, which is the capture's own.

## Not decided here — the port's `CLOSE` semantics

Whether a plain `CLOSE` aborts a stored read is out of scope for this record; it is tracked
as cameri/nostream#957.
