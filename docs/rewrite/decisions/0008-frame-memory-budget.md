# ADR 0008: A global frame-memory budget and a per-IP live-connection cap (job 016)

- **Status:** accepted (job 016, Phase 2)
- **Deciders:** the rewrite team, on the operator's policy comment on #959 and the evidence in job 016's recon and spec
- **Date:** 2026-10-24

## Context

The outbound frame queue was bounded per socket and nothing bounded their sum.
`RelayConfig::frame_queue_bytes` (8 MiB; `crates/nostream-relay/src/relay.rs:57`) is enforced by
`FrameSink::send`'s compare-and-exchange on the socket's own counter
(`crates/nostream-relay/src/sink.rs:260-334`), and `Relay::serve` accepted every connection with
no count at all. The only per-address bookkeeping was the **attempt** limiter, which throttles how
fast connections open, not how many are held (`crates/nostream-relay/src/limits.rs`, windows
consumed at `crates/nostream-relay/src/relay.rs:327`).

The operator's policy comment on #959 chose the numbers and the refusal and asked for two
consequences a reviewer can hold the change to: both bounds refuse the same way, and the budget is
released when a socket closes ("a leak here is worse than no bound").

**What the change is worth, measured.** One address that opens sockets and then stops reading held
`N × 8 MiB`. With the shipped attempt windows — 12 per 1 000 ms and 48 per 60 000 ms
(`resources/default-settings.yaml:215-224`) — one address gets 48 sockets a minute indefinitely, so
the pre-change worst case is **384 MiB**, and that figure is **arithmetic from named constants, not a measurement**; it is the same derivation the performance lens made, marked there as arithmetic.

**The failure the counter exists to avoid was measured on the wire.** Twenty sockets opened back to
back on a fresh daemon: the first twelve received `HTTP/1.1 101 Switching Protocols` and then a text
frame starting `["AUTH","…`, and the remaining eight were upgraded and dropped with **no websocket
close frame at all** — the attempt limiter's silent return
(`crates/nostream-relay/src/relay.rs:287-290`). A refusal indistinguishable from a network fault is
exactly what the new bounds are not allowed to be, so each of them closes with a code, a fixed
reason and its own counter.

## The two numbers, as deviations from the capture, with the arithmetic

The capture has neither bound. Its connection limits are `ConnectionLimits` — `rateLimits`,
`ipWhitelist`, `ipBlacklist` and no count (`src/@types/settings.ts:163-167`) — and its outbound
queue is unbounded (`src/adapters/web-socket-adapter.ts:150-155`). Both numbers below are therefore
deviations from the capture, and both are correct because the operator's comment names them, not
because a captured transcript shows them. There is no parity oracle for either: `wire_parity` cannot
see a bound the capture does not have.

| knob | default | the arithmetic |
|---|---|---|
| `frame_memory_budget_bytes` | **256 MiB** (`268_435_456` bytes) | 32 sockets at the 8 MiB `frame_queue_bytes` ceiling can be fully buffered before the budget binds — below the 48 a single address gets through the shipped attempt limits alone |
| `max_connections_per_ip` | **64** sockets | four times the concurrent total one well-behaved client needs, and above the 48 the attempt limiter alone allows in a minute |
| refusal | `1013`, immediate, no text frame | a frame the client will never read cannot be the way to say "you are not reading" |

The cap's own worst case is 64 × 8 MiB = **512 MiB**, deliberately **above** the budget. That is the
policy's own division of labour restated: the cap bounds sockets, the budget bounds bytes, and a
process whose sockets are all small can hold more of them than the budget-implied 32 without being
refused for it. Neither number is a total-memory ceiling; see the next section.

## What "frame memory" means here

Accounted **outbound payload bytes**: the `text.len()` that `frame_queue_bytes` already counts
(`crates/nostream-relay/src/sink.rs:269-270`), not `String` capacity, not the channel node, and not
resident memory. The nearest measurement of the ratio is job 010's probe D, which saw roughly 2 KiB
resident per 1 KiB queued at 1 KiB frames, so **256 MiB accounted is not a process RSS ceiling** and
should not be read as one.

Nothing else is counted. Inbound is bounded per message by `max_payload_size` (131 072 by default,
`crates/nostream-relay/src/transport.rs:50-57`), handler state is not counted at all, and the
hidden-content mirror and the event stores are outside the budget on purpose: they are not frames,
and folding them in would make one knob mean two things.

## The config surface — `RelayConfig`, not settings

Both fields are `RelayConfig` fields, `frame_memory_budget_bytes` at
`crates/nostream-relay/src/relay.rs:65` and `max_connections_per_ip` at `:69`, built into the relay's
two shared values in `Relay::new` (`:146-147`). ADR 0005 already decided the question for this class
of knob:

> The bound and the timeout are `RelayConfig` fields and not settings. The capture has no
> counterpart for either … so a settings key would be an operator-facing surface mirroring nothing.
> `RelayConfig` is where this branch already keeps the knobs the capture fixes in code …

— `docs/rewrite/decisions/0005-connection-concurrency.md:104-110`

**The honest cost:** an operator cannot change either number without a rebuild. "Configurable" here
means the value is readable and settable through a `RelayConfig` literal rather than buried in a
call site — a settings key, a YAML entry and a validator/guided-catalogue entry are **#989** and out
of scope for this job. Say it plainly rather than letting "configurable" read as a knob an operator
can edit in production; today they cannot.

`nostreamd` keeps `..Default::default()` in its `RelayConfig` literal
(`crates/nostreamd/src/main.rs:120-123`), and all five `Relay::new` call sites already did, so no
call site had to change.

## The refusal — `1013`, immediate, no text frame

Both bounds close the socket with `CloseCode::Again` (1013) written straight to the transport rather
than through the sink, bounded by `config.write_timeout` exactly as the existing slow-consumer close
is (`Relay::close_frame`, `crates/nostream-relay/src/relay.rs:530-541`). Three fixed reason strings
now exist, each lowercase and resource-stating, per the convention
`SLOW_CONSUMER_REASON` set (`crates/nostream-relay/src/transport.rs:37-47`):

- `SLOW_CONSUMER_REASON` — "slow consumer: outbound frame queue full", unchanged.
- `FRAME_BUDGET_REASON` — "frame memory budget exhausted".
- `CONNECTION_CAP_REASON` — "connection cap: too many connections from this address".

**Why not a `NOTICE`.** A NOTICE is a text frame, and an over-budget client is by definition one that
is not reading: the frame would sit in the very queue being refused, and a client at the cap has not
earned a JSON frame it did not ask for. The refusal has to be legible in the close frame, which every
websocket client reads, rather than in a payload it may never consume.

**Neither refusal is a timeout, and neither is the attempt limiter's.** The attempt limiter's refusal
is still the silent upgrade-then-drop measured above; this job leaves `RateLimits`, its windows and
its whitelist untouched. What separates the two new refusals from the limiter's silent drop is that
they say something: a close frame with **code `1013`** and a fixed reason string. What separates
them **from each other** is the reason string and the counter, not the code — plus the log line's
fields (`budget_bytes`/`accounted_bytes` against `peer`/`max_connections_per_ip`/`live`) and, for a
test driving the relay directly, the accessor (`FrameBudget::refusals` at
`crates/nostream-relay/src/sink.rs:91` or `ConnectionCap::refusals` at
`crates/nostream-relay/src/connection_cap.rs:60`). Both bounds use `CloseCode::Again`, so `1013` on
its own tells a client that it was refused and says nothing about which bound did it; anything that
wants to tell the two apart reads the reason string. That is what keeps both out of the "looks like
a network fault" bucket that started this.

**A budget refusal refuses the frame, not the socket.** The refusal cause is recorded once — so the
counter counts one refused socket, not one per frame, and the warn line is written once — but only a
queue-full refusal latches the sink shut. A budget refusal that latched would also have to be
un-latched when the drain side frees room, and it buys nothing: the connection loop closes the socket
at its next iteration whatever the sender does. The accounting therefore stays exact under either
choice, and the unit test that proves room lets the next frame through
(`sink.rs::the_budget_binds_across_sockets_and_is_shared`) can say so.

**The refusal stops the reader too, and the reader then waits for the close.** The connection loop
closes the socket at its next iteration, but a stored read is a task of its own and keeps producing
events until it notices: `fetch_and_send` encodes one frame per event
(`crates/nostream-relay/src/handlers/subscribe.rs:325-330`), and each refused frame was encoded and
discarded. The window is not short — the loop can be parked in a write and then in `close_frame`,
each bounded only by the 30 s `write_timeout`, and `handlers.abort_all()` runs only after both — and
it is the normal case, because the budget binds exactly when queues are full and loops are parked in
writes. So the read checks `context.sink.refusal()` at the top of its loop, before pulling or
encoding the next record (`crates/nostream-relay/src/handlers/subscribe.rs:284-288`), and sends
nothing more: no further event, and no `EOSE`, which would be a frame this client is not reading.

What the read does **not** do is finish there. It waits for the close that retires it — the
cancellation watch, then `end_read` — and what delivers that close is `handlers.abort_all()` and
`connection.close()` on the loop's way out (`crates/nostream-relay/src/relay.rs:494-495`). So a
refused client at this head holds two things until its socket actually closes: the read task, and
the store stream inside it (§7 records the second). The sink itself must not latch a budget refusal —
a frame that fits later is admitted, which the shared-budget test relies on — so the stop belongs to
the reader. `subscribe.rs::a_refused_sink_stops_the_read_instead_of_encoding_the_rest_of_it` holds it
down: with a 64-byte budget every event frame is refused and the `EOSE` would fit, so the queue stays
empty only if the read stopped at the first refusal, and the store's per-item gate shows it asked for
exactly one record (without the check it drains the stream and holds the 12-byte `EOSE`).

**The refusal wakes the loop.** Recording the cause is not enough on its own. A budget refusal
can arrive while *this* socket's queue is empty — the bytes that left no room are another
socket's — with the socket idle and the read that lost the frame waiting for the very close that
recording the refusal is supposed to start, and then nothing in the connection task is ready: no
frame to write, no inbound message, no handler finishing. The
account owns a `tokio::sync::Notify`, the first refusal signals it, and `run_connection` selects
on `FrameSink::refused()`, so the close is one iteration away rather than one liveness interval
away. `notify_one` stores a permit when nothing is waiting, which is what makes a refusal
recorded between the loop's check and its `select!` survive instead of being lost; two racing
refusals leave one permit, and the loop rechecks the cause it already reads at the top of every
iteration. The wire test that holds this down
(`tests/transport.rs::a_shared_budget_refusal_closes_the_socket_without_waiting_for_a_tick`)
times out at two seconds without the signal and closes in about 1.3 s with it.

## Where the budget binds: per-frame admission, not an accept-time reservation

The budget is enforced where the per-socket bound already is: in `FrameSink::send`, as a second
compare-and-exchange loop against `accounted + length > limit`
(`crates/nostream-relay/src/sink.rs:100-136`). Admission requires room in both bounds; the budget has
**no empty-queue exception** — unlike `frame_queue_bytes`, whose exception keeps one large event from
closing every client — because 256 MiB exceeds any single outbound frame the protocol can produce by
three orders of magnitude, and strictness is what makes a one-byte test budget meaningful.

**The rejected shape: an accept-time reservation.** Refusing new sockets when the budget is already
full is the reading a "global budget" invites, and it is wrong for two reasons. It does not bound what
an admitted socket may queue — a socket admitted into an empty budget can still queue its 8 MiB, so
the bound has to exist at the sink regardless, and adding an accept-time gate buys a second bound
beside it rather than replacing it. And a reservation needs its own lifecycle: take bytes at accept,
refund them on every exit, and get the partial case right when a socket used less than it reserved —
which is a second refund path of exactly the kind section 7 exists to eliminate. Per-frame admission
has one lifecycle (bytes are counted when a frame is admitted, uncounted when it is written or when
the socket's accounting ends) and refuses the frames that actually need the memory.

**The blast radius is one address, and it is new.** The budget is shared, so it is only as fair as
the sockets already holding it. Eight sockets at the 8 MiB `frame_queue_bytes` ceiling are 64 MiB and
32 of them are 256 MiB, so **one address stays below its own 64-socket cap and still exhausts the
budget** — and then every other client's next frame is refused and its socket closed, including a
new client's AUTH challenge, which is a text frame like any other and is refused before that client
has been spoken to. Before this change there was no shared bound to exhaust: one address could hold
`N × 8 MiB` of its own, but it could not make another client's connection fail. That is the shape the
operator's comment chose — a shared bound over a per-address one — and it is recorded here as a cost
of it, not as a defect.

## The refund, and the shape rejected

**Chosen: refund on the last handle's `Drop`.** `FrameSink` holds an `Arc<Account>`
(`crates/nostream-relay/src/sink.rs:201-207`); the account carries the socket's outstanding bytes,
its refusal cause and the shared budget, and `impl Drop for Account`
(`crates/nostream-relay/src/sink.rs:191-197`) returns whatever is left of that socket's bytes to the
budget. Every clone of the socket's sink shares the account, so the drop that runs is the last one: a
send holds a sink and therefore cannot be in flight or begin once that drop starts. That is what makes
the refund **exactly this socket's bytes, once**, whatever the connection loop did on the way out.

**The rejected shape: a decrement at each of the loop's exits.** Today `release` has exactly one
caller, the drain arm (`crates/nostream-relay/src/relay.rs:407`), and every other exit leaves whatever
was still queued counted: the drain itself (`:384-385`), the refusal close (`:391-394`), the `None`
receiver (`:398`), a failed write (`:409-411`), the inbound arms (`:414`, `:433-435`, `:440`,
`:443-445`), the closed hub (`:460`), the liveness arms (`:463-469`, `:479-481`) and the final
cleanup (`:494-495`); the lagged hub (`:455-457`) warns and does not leave. Per socket that leak is
invisible because the counter dies with the sink; a process-wide budget makes it a leak of up to
8 MiB on every disconnect. Writing the decrement at each of those sites is the change that looks
right and rots:
the next exit added to the loop silently leaks, and no unit test can reach the exits that need a
failed handshake or a poisoned store to trigger. `Drop` covers all of them by construction, including
the registration failure inside `run_connection` — which matters, because a refund that ran only on
the happy exit would fail AC8's test.

The drain arm's `release` is unchanged and still runs: it returns written bytes promptly, so the
budget is reusable while the socket lives, and the `Drop` refund then finds only what was never
written.

**The parked read holds its store stream, and that is what must change when a store is wired.**
Stopping at the refusal without leaving the loop keeps the stream from `find_by_filters` alive until
the close retires the read; the version before this one dropped it at the refusal. Latent today — the
daemon wires `unavailable::stores()` (`crates/nostreamd/src/main.rs:113`), whose reads are stubs —
but not for ever: sqlx's `&Pool` executor draws a pooled connection for as long as a query stream is
alive, and `DB_MAX_POOL_SIZE` defaults to **3** (`crates/nostream-storage/src/postgres/mod.rs:362`),
so three refused reads parked at once would hold every connection in the pool and stall every other
read in the process. Whoever wires the store leaves the loop before parking — returning from
`fetch_and_send`, or dropping the stream first — and pays for it in test power: a handler that
returns wakes the loop on completion, so the close arrives promptly even with the refusal signal
deleted, and the wire test below then holds down nothing (static round 2 is exactly what that looked
like). That trade — a pooled connection against the signal being load-bearing — is recorded here so
it is made on purpose rather than by accident.

## The per-IP cap

A `ConnectionCap` (`crates/nostream-relay/src/connection_cap.rs`) counts **live sockets** per
`peer.ip().to_string()` — the same string the attempt limiter's buckets are keyed on — and is
checked in `handle_socket` **after** `is_connection_rate_limited` and **before** `run_connection`:

- after the limiter, so a rate-limited socket is still dropped silently as it always was, takes no
  slot, and needs no refund on that path;
- before `run_connection`, because `Connection::accept`'s first act is to send the NIP-42 challenge
  as a text frame (`crates/nostream-relay/src/connection.rs:109-115`) — a client refused afterwards
  would already have received a text frame, which the policy forbids. The window is
  `crates/nostream-relay/src/relay.rs:292-315`.

Acquisition returns a `ConnectionSlot` held for the rest of `handle_socket`
(`crates/nostream-relay/src/relay.rs:299`), so the normal exit, the registration failure inside
`run_connection`, and any early return added later all release it through `Drop`
(`crates/nostream-relay/src/connection_cap.rs:101-116`). A count that leaks makes the cap permanent
for that address, which is a defect and not a memory leak. The map entry is removed when its count
reaches zero (`:112-114`), so an address that once connected leaves nothing behind and the map is
bounded by live addresses.

The cap applies to **every address, including whitelisted ones**. An exempt address would bypass the
memory bound the cap protects, and the limiter's `ipWhitelist` behaviour is untouched: the whitelist
answers "skip the rate window", not "hold unlimited sockets".

This is a gauge, not a window: no store, no clock, no expiry. `RateLimits` and `limits.rs` are
unchanged, and the measured 20-socket behaviour — 12 served, 8 dropped by the limiter — is unchanged
with it.

**The key is an address, not an identity.** The cap counts source addresses, which is what the
policy's name says, and it holds on the shipped bind: `nostreamd` listens on
`SocketAddr::from((Ipv4Addr::UNSPECIFIED, port))` (`crates/nostreamd/src/main.rs:90`), so every
client has a distinct IPv4 source address. The relay is a library, though, and a listener bound to
`[::]` keys an IPv6 peer by its full address: one host holding a /64 may present 2^64 source
addresses, one socket each, and the cap then bounds nothing. Closing that is a policy about
prefixes, and it is not this job's.

## What an operator can see today

Two accessors in the `hidden_content()` style, `Relay::frame_budget()` and
`Relay::connection_cap()` (`crates/nostream-relay/src/relay.rs:175-182`), and the counters behind
them: `accounted()`, `limit()`, `refusals()` on the budget; `live(ip)`, `max_per_ip()`,
`refusals()`, `tracked_addresses()` on the cap. Plus two structured log lines, one per refusal — a
`warn!` carrying `budget_bytes` and `accounted_bytes` from the sink
(`crates/nostream-relay/src/sink.rs:321-325`), and a `debug!` carrying `peer`,
`max_connections_per_ip` and `live` from the connection task
(`crates/nostream-relay/src/relay.rs:300-305`).

**Those two lines are not visible at the same level, and the daemon ships `info`.** The filter is
`--log-level`, then `LOG_LEVEL`, then `RUST_LOG`, else `info`
(`crates/nostreamd/src/telemetry.rs:10-23`). At the shipped default an operator therefore sees the
budget's `warn!` and **not** the cap's `debug!`: a socket refused at the cap leaves no line an
operator will find, which is the silent-invisibility failure this job exists to remove, restored on
one of the two paths. Seeing it takes `--log-level debug` (or `LOG_LEVEL=debug`, or a `RUST_LOG`
directive for `nostream_relay`). The reason the line is `debug!` and not something louder is that it
carries per-socket detail — `peer`, `live` — and would be log-amplifiable by exactly the client that
trips it; the process-wide fact belongs to the counter instead. Which leaves the counters as the
surface that does not depend on a log level, and they are readable only from a `Relay` handle today,
i.e. from a test or an embedder. **Making either refusal visible to an operator who has not raised
the filter is an open gap, and #989 or the `/metrics` work is where it closes.**

That is the whole surface, because **a Prometheus endpoint is out of reach right now**: the OTLP
exporter is a stub returning `NotImplemented` (`crates/nostreamd/src/telemetry.rs:47-52`) and the
admin `/metrics` controller is a Phase-1 stub (`crates/nostream-admin/src/controllers/get_metrics.rs:5-9`).
There is no registry to publish into. When `/metrics` lands, an exporter reads these two counters and
nothing here needs to change; until then the counters and the two log lines are the deliverable, and
this job deliberately adds no metrics subsystem.

## What this does not decide

- **The operator-facing settings key** for either number: #989, with the YAML entry, the validator
  and the guided catalogue it drags in.
- **Any exporter, dashboard or alerting.** No registry, no `/metrics` controller, no admin or
  telemetry change.
- **Anything per listener.** One `Relay` carries one budget, and a second listener served by the same
  `Arc<Relay>` shares it (`Acceptor::run` calls `relay.serve(listener)`,
  `crates/nostreamd/src/acceptor.rs:56-60`). A `static` would give the same sharing and cost the test
  suite the ability to run two relays with different budgets in one process; two `Relay::new` calls
  are the only way to get two budgets, and production makes one.
- **The per-socket bound's own empty-queue exception**, its default, and `SLOW_CONSUMER_REASON`.
- **Inbound memory or handler state**, neither of which the budget counts.
- **Any validation of the two numbers.** A zero budget or a zero cap is a literal the operator wrote;
  policing it is a settings decision this job does not own.
