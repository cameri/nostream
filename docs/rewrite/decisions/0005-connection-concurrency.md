# ADR 0005: Connection concurrency — read ownership, a bounded frame queue, and liveness under a blocked write (job 010)

- **Status:** accepted (job 010 and job 012, Phase 2)
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

The generation is a counter and not a per-read token. Identity comparison is available —
`watch::Sender::same_channel` and `watch::Receiver::same_channel` — so an entry holding the
sender could end a read by comparing the returning read's handle against it. What rejects
that route is cost, not impossibility: `watch::channel(false)` allocates its shared state
once per read either way, and identity would add a *second* watch handle to every entry (the
sender, plus a receiver the entry never awaits), while the generation adds one `u64` beside
the one handle the table already holds. The generation is also the value a returning read can
still carry after its own handle has been replaced, and the value that names the owner in the
table; the rule is tested through behaviour (`tests/connection.rs:208-231`), not by value. It
fits the locking the file already has: `impl Connection` contains no `.await`, so no lock is
ever held across a suspension point, and the counter is read and written inside the same
`insert` that replaces the previous sender. No second lock, no allocation outside the guard,
and no new state for a caller to keep.

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
bound, unless the queue is empty, so one frame larger than the whole bound still reaches the
client instead of closing every client on a large event. A dropped frame sets an overflow
flag and the senders that set it each log one warning carrying the bound and the current
depth (one line per racing sender, not one per connection); once the flag is set every later
send is dropped without queueing. The draining side releases a frame's bytes when its write
completes. The default bound is 8 MiB, which is above any single outbound frame and a few
hundred times below the 405 MiB an unbounded queue reached when 200 000 frames were queued
with nothing draining.

The full-queue policy is **disconnect**: the connection loop closes the client with 1013 and
the fixed reason `slow consumer: outbound frame queue full` once its socket accepts bytes
again — a client whose socket never does is ended by `write_timeout` instead, with no close
frame — and then falls through to the existing cleanup.

What the client experiences at that point is a truncation, not a clean stop: the frames already
written to its socket still arrive, in order, and then the close; frames the sink had admitted
and this run never wrote are frames it will never read, and nothing in the stream marks where
the cut fell — no `EOSE`, no count, only the close frame. Draining is not the alternative for
the client this bound exists for — one that has stopped reading — because draining means writing
to a socket that is not taking bytes, which is the condition that produced the overflow; the
relay would be waiting on precisely the client it has already failed to serve. That is the trade
the policy makes: some frames one client will never read, in exchange for a relay that keeps
serving everyone else.

Three alternatives lost:

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
key would be an operator-facing surface mirroring nothing. `RelayConfig` is where this branch
already keeps the knobs the capture fixes in code — with the tests setting the cadences they
need — and these two port-only policies, which every test so far runs at their defaults.

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
for a large frame on a slow link. Because no write the connection task performs can hold it
longer than that timeout — and the drain's own writes are further bounded by `drain_timeout`
from the serve loop — the tick can be delayed by at most 30 s, which is the interval's own
order of magnitude rather than the unbounded stall it was.

The overflow flag is read at the top of every loop iteration. No `await` sits between a
write returning and that check, so a flag a producer set while the loop was parked is acted
on as soon as the write completes.

## The invite emit stays unguarded

The read is registered before the invite mint's only `await`, and its cancellation is
checked before the stored read opens, so a `CLOSE` ends the subscription with no stored
event and no `EOSE`. Since §"Inbound dispatch order" below, that `CLOSE` cannot be handled
ahead of its own `REQ` either: a handler's prefix runs on the connection loop before the next
frame is read, which is what closed cameri/nostream#958. The invite `EVENT` is nonetheless
still emitted for that closed subscription. That is deliberate parity, not an oversight: the
capture emits the invite event unguarded
(`src/handlers/subscribe-message-handler.ts:111`) and attaches its abort signal only to the
stored read (`:230`), while it sets the abortable subscription id as the handler's first
statement (`:53`). The TypeScript tree wins where the two trees disagree absent a decision
record, so the fix must not reach for the emit; the exposure it leaves is one stray
`EVENT`, which is the capture's own.

## Inbound dispatch order — a prefix on the loop, not a serialized handler

An inbound frame's handler was spawned whole into the per-socket `JoinSet`, so two frames
read in order ran in whichever order the scheduler picked: a `CLOSE` could be handled ahead
of its own `REQ` and find nothing to abort, and a restricted `REQ` could be refused before
the `AUTH` that preceded it had been handled. Both were measured through a real socket —
30/30 runs at one worker for the `REQ`/`CLOSE` pair, 10/10 at two for `AUTH`/`REQ` — and
neither was visible to the suite, because `#[tokio::test]` defaults to the one runtime flavour
in which a spawned handler cannot overtake the task that spawned it.

The decision is the capture's own division of a message: its **ordering-sensitive prefix**
runs before the next frame is read, and its continuations stay concurrent.
`handlers::begin` runs each prefix on the connection loop and returns the continuation for
the `JoinSet`. The prefixes are `subscribe` (everything through `begin_read`, so the
subscription and its read exist before a following `CLOSE` is looked at), `unsubscribe` (the
whole handler) and `auth` (the whole handler, which has no `await`). `EVENT` and `COUNT` keep
their whole body as one spawned future: what they do before their first `await` touches the
rate limiters and the settings, which no later frame reads in arrival order, and moving it
would add loop latency to the hottest inbound path for no capture-visible difference.

Two shapes were rejected. **Serializing whole handlers** — an ordered queue drained in the
loop — would run a `REQ`'s invite mint to completion before a `CLOSE` already in the buffer
is looked at, which the capture permits and `tests/handlers.rs` asserts, and it would put
every database write in front of the socket's whole read path. **An ordering token per
connection** — a per-id "closed at sequence N" consulted by `begin_read` — needs the second
structure in `InFlightReads` this record argues against in §"Read ownership", must be bounded
or evicted, needs a rule for what an "older" `REQ` means under a re-`REQ`, and orders
`AUTH` before a restricted `REQ` only with a second, unrelated rule.

What this does not decide: it is a guarantee about prefixes, not about handler execution.
Continuations interleave as before, so a `CLOSE` during a gated invite mint still aborts the
read and the invite `EVENT` is still emitted. The cost accepted is that
`normalise_subscription` and `can_subscribe` run on the loop task, bounded by
`transport::max_payload_size` and, where configured, `max_filters` / `max_filter_values`;
the capture does the same work on its socket's thread.

## Not decided here — the port's `CLOSE` semantics

Whether a plain `CLOSE` aborts a stored read is out of scope for this record; it is tracked
as cameri/nostream#957.
