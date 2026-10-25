# ADR 0008: A global frame-memory budget and a per-IP live-connection cap (job 016)

- **Status:** accepted (job 016, Phase 2)
- **Deciders:** the rewrite team, on the operator's policy comment on #959 and the evidence in job 016's recon and spec
- **Date:** 2026-10-24

## Context

The outbound frame queue was bounded per socket and nothing bounded their sum.
`RelayConfig::frame_queue_bytes` (8 MiB; `crates/nostream-relay/src/relay.rs:58`) is enforced by
`FrameSink::send`'s compare-and-exchange on the socket's own counter
(`crates/nostream-relay/src/sink.rs:260-334`), and `Relay::serve` accepted every connection with
no count at all. The only per-address bookkeeping was the **attempt** limiter, which throttles how
fast connections open, not how many are held (`crates/nostream-relay/src/limits.rs`, windows
consumed at `crates/nostream-relay/src/relay.rs:479`).

The operator's policy comment on #959 chose the numbers and the refusal and asked for two
consequences a reviewer can hold the change to: both bounds refuse the same way, and the budget is
released when a socket closes ("a leak here is worse than no bound").

**What the change is worth, measured.** One address that opens sockets and then stops reading held
`N × 8 MiB`. With the shipped attempt windows — 12 per 1 000 ms and 48 per 60 000 ms
(`resources/default-settings.yaml:219-229`) — one address gets 48 sockets a minute indefinitely, so
the pre-change worst case is **384 MiB**, and that figure is **arithmetic from named constants, not a measurement**; it is the same derivation the performance lens made, marked there as arithmetic.

**The failure the counter exists to avoid was measured on the wire.** Twenty sockets opened back to
back on a fresh daemon: the first twelve received `HTTP/1.1 101 Switching Protocols` and then a text
frame starting `["AUTH","…`, and the remaining eight were upgraded and dropped with **no websocket
close frame at all** — the attempt limiter's silent return
(`crates/nostream-relay/src/relay.rs:439-442`). A refusal indistinguishable from a network fault is
exactly what the new bounds are not allowed to be, so each of them closes with a code, a fixed
reason and its own counter.

## The two numbers, as deviations from the capture, with the arithmetic

The capture has neither bound. Its connection limits are `ConnectionLimits` — `rateLimits`,
`ipWhitelist`, `ipBlacklist` and no count, in the capture's settings types — and its outbound
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
`crates/nostream-relay/src/relay.rs:66` and `max_connections_per_ip` at `:70`, built into the relay's
two shared values in `Relay::new` (`:146-147`). ADR 0005 already decided the question for this class
of knob:

> The bound and the timeout are `RelayConfig` fields and not settings. The capture has no
> counterpart for either … so a settings key would be an operator-facing surface mirroring nothing.
> `RelayConfig` is where this branch already keeps the knobs the capture fixes in code …

— `docs/rewrite/decisions/0005-connection-concurrency.md:105-111`

**The honest cost, as this job left it:** an operator could not change either number without a
rebuild, because "configurable" meant readable and settable through a `RelayConfig` literal rather
than buried in a call site. **#989 resolved that, and the resolution is recorded here rather than
in a second document.** Both numbers are now operator settings, `network.frameMemoryBudgetBytes` and
`limits.connection.maxConnectionsPerIp` in `resources/default-settings.yaml`, typed as optional
leaves beside the keys that already live in those sections:
"pub max_connections_per_ip: Option<u64>," (`crates/nostream-config/src/settings.rs:312`).

`from_settings` is the one place either setting is *interpreted* — the daemon and the test share
it, so they cannot drift: "pub fn from_settings(settings: &Settings) -> Self {"
(`crates/nostream-relay/src/relay.rs:203`). The daemon calls it once and keeps its one environment
read: "let mut relay_config = RelayConfig::from_settings(&settings);"
(`crates/nostreamd/src/main.rs:110`). One other function walks the same two leaves — `refused_bounds`,
so the gate and the CLI can report a value the constructor will not take:
"pub fn refused_bounds(settings: &Settings) -> Vec<(&'static str, BoundRefusal)> {"
(`crates/nostream-relay/src/relay.rs:130`). It never produces a config;
`from_settings` is the only reader whose answer the relay runs with.

The two cannot disagree because `bound_refusal` **asks `in_range` first** rather than comparing the
ceiling a second time — "    if in_range(value) {" (`crates/nostream-relay/src/relay.rs:155`) — so a
value the constructor accepts is never reported as refused, and a typed edit that retyped the
comparison would fail `the_refusal_verdict_and_the_range_agree_at_every_boundary`
(`crates/nostream-relay/tests/config_defaults.rs`), which asserts the verdict at zero, one, the
ceiling and one over it. `RelayConfig::default()` remains the single source of the two
numbers — the document mirrors it, and a test in `crates/nostream-relay/tests/config_defaults.rs`
fails when they part — because a missing key must still mean a working relay, not a relay that
needs the document at start-up. The compiled values are unchanged:
"frame_memory_budget_bytes: 256 * 1024 * 1024," (`crates/nostream-relay/src/relay.rs:92`) and
"max_connections_per_ip: 64," (`crates/nostream-relay/src/relay.rs:97`).

Two consequences a reader should have in one place. The document gains its first key whose name
states a byte unit, `frameMemoryBudgetBytes`; the convention it breaks is that the unit lives in
prose (`network.maxPayloadSize` is "bytes accepted per WebSocket frame" in `CONFIGURATION.md` and
carries no suffix). The suffix stays because #989 names the field `frame_memory_budget_bytes`, and
a YAML key that disagreed with the Rust field would be a second name for one number; the comment
above the key states the unit regardless. **#996 added the validator rule this section used to say
there was none of:** a stated `0` is an issue on both keys, and every pre-existing message stays
byte-identical (`crates/nostream-config/tests/ts_parity.rs` pins them, and no fixture sets either
bound, so the exemption set is unchanged).

**A zero is neither "disabled" nor "the default" for either number** — it is invalid, and *What `0`
means*, below, says why.

## The refusal — `1013`, immediate, no text frame

Both bounds close the socket with `CloseCode::Again` (1013) written straight to the transport rather
than through the sink, bounded by `config.write_timeout` exactly as the existing slow-consumer close
is (`Relay::close_frame`, `crates/nostream-relay/src/relay.rs:682-693`). Three fixed reason strings
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

**The refusal stops the reader too, and the abort eventually retires it.** The connection loop
closes the socket at its next iteration, but a stored read is a task of its own and keeps producing
events until it notices: `fetch_and_send` encodes one frame per event
(`crates/nostream-relay/src/handlers/subscribe.rs:326-331`), so a frame that does not fit has been
encoded by the time the sink refuses it. The window is not short — the loop can be parked in a write
and then in `close_frame`, each bounded only by the 30 s `write_timeout`, and `handlers.abort_all()`
runs only after both — and it is the normal case, because the budget binds exactly when queues are
full and loops are parked in writes. So the read checks `context.sink.refusal()` at the top of its
loop, before pulling or encoding the next record
(`crates/nostream-relay/src/handlers/subscribe.rs:285-289`), and sends nothing more: no further
event, and no `EOSE`, which would be a frame this client is not reading. That leaves the frame that
was refused as the only one encoded and thrown away per read — one, not one per event — and a socket
the queue bound has already latched does not even pay that, because `send` returns before `to_text()`
(`crates/nostream-relay/src/sink.rs:260-266`).

The read does not finish there: it waits on the read's cancellation watch and then calls `end_read`.
**On the refusal path that wait is never resolved.** Every exit of the connection loop is a `break`,
`handlers.abort_all()` runs before `connection.close()` (`crates/nostream-relay/src/relay.rs:646-647`),
and a task aborted by the `JoinSet` it was spawned into (`crates/nostream-relay/src/relay.rs:529`,
`:602-603`) is dropped without being polled again: the parked read is dropped inside the watch, the
`end_read` below it never runs, and the store stream goes with it. What retires a refused read in
production is therefore the abort, not the watch — the watch is the path a client can still take, by
a `CLOSE` or a re-`REQ`, and it is the one the unit test exercises, because the test closes the
connection rather than aborting the task. So a refused client holds two things until the loop aborts
it, a close frame later: the read task, and the store stream inside it (§7 records the second).

The sink itself must not latch a budget refusal — a frame that fits later is admitted, which the
shared-budget test relies on — so the stop belongs to the reader.
`subscribe.rs::a_refused_sink_stops_the_read_instead_of_encoding_the_rest_of_it` holds it down with a
64-byte budget, where every event frame is refused and the `EOSE` would fit: the queue stays empty
only if the read stopped at the first refusal, and the store's per-item gate shows it asked for
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
caller, the release after a frame is written (`crates/nostream-relay/src/relay.rs:559`), and every
other exit leaves whatever was still queued counted: the drain entry (`:535-537`), the refusal
close (`:543-545`), the closed frame queue (`:550`), a failed write (`:561-563`), the closed
inbound stream (`:566`), an inbound `CLOSE` (`:592`), a failed read (`:594-596`), a failed pong
write (`:585-587`), the closed hub (`:612`), the pong timeout (`:619`) and a failed ping write
(`:631-633`) and the final cleanup (`:646-647`); the lagged hub (`:607-609`) warns and does not
leave. Per socket that leak is
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
the loop aborts the read, a close frame later; the version before this one dropped it at the refusal.
Latent today — the daemon wires `unavailable::stores()` (`crates/nostreamd/src/main.rs:118`), whose
reads are stubs — but not for ever: sqlx's `&Pool` executor draws a pooled connection for as long as a
query stream is alive. The size that matters is the deployed one, not the code's: `DB_MAX_POOL_SIZE`
defaults to **3** (`crates/nostream-storage/src/postgres/mod.rs:362`) but
`deploy/docker-compose.prod.yml` sets **64** (`:16`) and configures no replica, so the connection a
refused read holds is one the master cannot serve a *write* with either — and the pool goes at one
connection per parked read: three read only because the code default is 3, sixty-four because the
deployed one is 64. Whoever wires the store leaves the
loop before parking — returning from `fetch_and_send`, or dropping the stream first — and pays for it
in test power: a handler that returns wakes the loop on completion, so the close arrives promptly
even with the refusal signal deleted, and the wire test in the wake-up paragraph above then holds
down nothing (static round 2 is exactly what that looked like). That trade — a pooled connection
against the signal being load-bearing — is recorded here so it is made on purpose rather than by
accident.

## The per-IP cap

A `ConnectionCap` (`crates/nostream-relay/src/connection_cap.rs`) counts **live sockets** per
`peer.ip().to_string()` — the same string the attempt limiter's buckets are keyed on — and is
checked in `handle_socket` **after** `is_connection_rate_limited` and **before** `run_connection`:

- after the limiter, so a rate-limited socket is still dropped silently as it always was, takes no
  slot, and needs no refund on that path;
- before `run_connection`, because `Connection::accept`'s first act is to send the NIP-42 challenge
  as a text frame (`crates/nostream-relay/src/connection.rs:109-115`) — a client refused afterwards
  would already have received a text frame, which the policy forbids. The window is
  `crates/nostream-relay/src/relay.rs:444-468`.

Acquisition returns a `ConnectionSlot` held for the rest of `handle_socket`
(`crates/nostream-relay/src/relay.rs:451`), so the normal exit, the registration failure inside
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
`Relay::frame_budget()` (`crates/nostream-relay/src/relay.rs:327-329`) and
`Relay::connection_cap()` (`crates/nostream-relay/src/relay.rs:332-334`), and the counters behind
them: `accounted()`, `limit()`, `refusals()` on the budget; `live(ip)`, `max_per_ip()`,
`refusals()`, `tracked_addresses()` on the cap. Plus two structured log lines, one per refusal — a
`warn!` carrying `budget_bytes` and `accounted_bytes` from the sink
(`crates/nostream-relay/src/sink.rs:321-325`), and a `debug!` carrying `peer`,
`max_connections_per_ip` and `live` from the connection task
(`crates/nostream-relay/src/relay.rs:452-457`).

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
the filter is an open gap. #989 did not close it either: the in-budget fix is a `debug!` → `warn!`
flip that reverses the log-amplification reasoning above, and the real surface is two
`NotImplemented` stubs, so #989 recorded the gap as a disposition and moved no log level.**

That is the whole surface, because **a Prometheus endpoint is out of reach right now**: the OTLP
exporter is a stub returning `NotImplemented` (`crates/nostreamd/src/telemetry.rs:47-52`) and the
admin `/metrics` controller is a Phase-1 stub (`crates/nostream-admin/src/controllers/get_metrics.rs:5-9`).
There is no registry to publish into. When `/metrics` lands, an exporter reads these two counters and
nothing here needs to change; until then the counters and the two log lines are the deliverable, and
this job deliberately adds no metrics subsystem.

## What this does not decide

- **~~The operator-facing settings key~~ for either number** — settled by #989, and recorded in
  *The config surface* above: two YAML keys and the `RelayConfig::from_settings` constructor.
  ~~no validator rule~~: #996 added one rule per key, refusing a stated `0` (*What `0` means*).
- **Any exporter, dashboard or alerting.** No registry, no `/metrics` controller, no admin or
  telemetry change.
- **Anything per listener.** One `Relay` carries one budget, and a second listener served by the same
  `Arc<Relay>` shares it (`Acceptor::run` calls `relay.serve(listener)`,
  `crates/nostreamd/src/acceptor.rs:56-60`). A `static` would give the same sharing and cost the test
  suite the ability to run two relays with different budgets in one process; two `Relay::new` calls
  are the only way to get two budgets, and production makes one.
- **The per-socket bound's own empty-queue exception**, its default, and `SLOW_CONSUMER_REASON`.
- **Inbound memory or handler state**, neither of which the budget counts.
- **Any validation of the two numbers, beyond the zero.** ~~A zero budget or a zero cap is still not
  refused — it is read as the default~~: #996 refuses a stated `0` and leaves absent as the only
  route to the compiled default (*What `0` means*). The ceiling still falls back rather than
  refusing, the validator still reports no range fault, and a bounded-integer rule for the guided
  editor is still not taken — see *What `0` means* for that gap stated as a gap.

## What `0` means
#989 left this question here by name and this section answers it, after the code was final.
**#996 reversed #989's answer.** This section now states the answer the code gives: a stated
zero is rejected, by name, before a relay exists.

**What `0` means: invalid.** Neither key's zero disables its bound and neither is read as the
default. A `0` written for either key is a validator issue: `network.frameMemoryBudgetBytes:
frameMemoryBudgetBytes must be greater than 0` and `limits.connection.maxConnectionsPerIp:
maxConnectionsPerIp must be greater than 0`. Both verdict surfaces — `nostreamd --check` and
`nostream-cli config validate` — report it and exit 2; a normal start reports it and serves on the
shipped defaults. *What a rejected document leaves to report*, below, separates the two start
paths and gives the line and the exit code for each.

The rule sits in `validate_document` beside the two adaptive-pow numbers, in the shape they
already established —
"            \"frameMemoryBudgetBytes must be greater than 0\","
(`crates/nostream-config/src/validate.rs:82`) and
"            \"maxConnectionsPerIp must be greater than 0\","
(`crates/nostream-config/src/validate.rs:91`) — and each has one test that a `0` yields that
key's issue and nothing else (`rejects_a_zero_frame_memory_budget`,
`rejects_a_zero_max_connections_per_ip` in `crates/nostream-config/tests/validator.rs`).

**Absent still means the compiled default.** That is the other half of the answer, and the one
`--check --config-dir <empty>` measures: with no user document `load` returns the shipped
defaults with `used_defaults` false, `268435456` and `64` are in range, and the verdict is
`settings valid: 0 issues`, exit 0. `check_reports_nothing_for_the_shipped_defaults` pins that
case, and `an_absent_setting_falls_back_to_the_compiled_default` pins it through the
constructor.

**Why rejection, and not a fallback.** Three reasons, in the order they weigh:

1. **A literal the operator wrote.** A zero here is a claim about the relay, not a request for
   a number the operator did not type. The disposition this section used to hold said so in a
   different place and then made an exception of these two keys: "A zero budget or a zero cap
   is a literal the operator wrote" (`docs/rewrite/decisions/0008-frame-memory-budget.md:369`).
   One sentence, one reading.
2. **It would be a fourth meaning for the same numeral.** The repository already has two, and
   they are both in the code, each with its own idiom: *disabled* —
   "    if max_subscriptions > 0" (`crates/nostream-relay/src/handlers/subscribe.rs:376`),
   which is what `CONFIGURATION.md` documents for the `limits.client.subscription` family — and
   *invalid*, which is what the adaptive-pow numbers do with it. *Use the default* is a third
   disposition, and the default read is a fourth idiom, belonging to a setting where absence and
   zero are genuinely the same statement —
   "        .filter(|size| *size > 0)" (`crates/nostream-relay/src/transport.rs:55`). These two
   keys belong to neither: *disabled* is defensible for a subscription count and not for a memory
   budget or a socket cap (it means an unbounded outbound queue and an unlimited socket count per
   address — the exposure *The two numbers* above measures), and the default read would make a
   typo strictly worse than the default it replaced.
3. **Rejection fails loudly and early.** The app names the key and exits non-zero, so the operator
   fixes the file; a fallback turns a typo into a relay that silently budgets 256 MiB and says
   nothing at start-up.

**The constructor takes a present leaf as written.** `in_range` answers the ceiling question and
nothing else —
"    value <= MAX_SETTING_BOUND as u64" (`crates/nostream-relay/src/relay.rs:115`) — applied to
the budget leaf at
"        if let Some(bytes) = settings.network.frame_memory_budget_bytes {"
(`crates/nostream-relay/src/relay.rs:206`) and to the cap through the two optional levels the
typed schema forces —
"            .and_then(|connection| connection.max_connections_per_ip)"
(`crates/nostream-relay/src/relay.rs:225`). An absent leaf keeps `RelayConfig::default()`'s
value, so absence — absent leaf, absent `limits`, absent `limits.connection` — is the only way to
the compiled default.
`a_zero_setting_is_the_value_the_relay_runs_with` in
`crates/nostream-relay/tests/config_defaults.rs` pins the constructor's half: given a zero, it
runs with the zero, per leaf. That test is not a licence to write one — the validator is what
stops the document from reaching the constructor.

**Why a ceiling, and not just a range check on both ends.** `usize::MAX` *is* a `usize`, so a
bare upper-bound check cannot be the only one, and a budget of `usize::MAX` stops bounding
anything: the fit guard subtracts with
`            if bytes > self.limit_bytes.saturating_sub(accounted) {`
(`crates/nostream-relay/src/sink.rs:107`), which can never be true against a limit of
`usize::MAX`, while the accounting that follows adds unchecked —
"                accounted + bytes," (`crates/nostream-relay/src/sink.rs:113`) — so it panics in a
debug build and wraps in a release one, and a wrapped counter refills the budget it was meant to
exhaust. The ceiling is what keeps an operator's number out of that arithmetic:
"pub const MAX_SETTING_BOUND: usize = 1024 * 1024 * 1024 * 1024;"
(`crates/nostream-relay/src/relay.rs:107`). One number serves both keys because one predicate reads
them, and each reads it in its own unit: 1 099 511 627 776 **bytes** is 1 TiB of queued frames for
`network.frameMemoryBudgetBytes`, and 1 099 511 627 776 **sockets** for
`limits.connection.maxConnectionsPerIp` — a count no deployment reaches, and the reason the cap's
share of the constant is generous rather than tuned. Both are far below `usize::MAX`; a too-large
value falls back, the zero no longer does, and a value at the ceiling is accepted. **The unchecked
add itself is not this job's** — it predates the bounds and is unreachable through settings now —
so it is reported rather than changed here.

**The over-ceiling fallback is not silent any more, and it used to be.** Measured before this
fix, `--check` printed `settings valid: 0 issues` for `1099511627776` and for `1099511627777`,
whose enforced budgets differ by 4096× (1024 GiB against 268 435 456), and said nothing about the
second. A value-level fallback is this repository's policy for an **over-range** value —
`network.maxPayloadSize` behaves the same and `--check` reports schema faults, not range — so the
ceiling keeps the fallback and only the zero becomes an issue. The three places an operator looks
report it: `in_range` stays the one range question, and `bound_refusal` says why —
"pub fn bound_refusal(value: u64) -> Option<BoundRefusal> {"
(`crates/nostream-relay/src/relay.rs:153`).

At start-up the constructor warns, once per leaf —
"            \"a bound above its ceiling runs with its default\""
(`crates/nostream-relay/src/relay.rs:180`) — naming the setting, the value, the ceiling and the
default. There is no zero arm, because a zero never reaches the constructor from a loaded
document: it is an issue, and the daemon continues on the shipped defaults.
`warn!` rather than `debug!` because the start-up line is a one-off statement about a
configuration that is wrong, not a per-request event, so it is not log-amplifiable by a client.

**One place produces the words.** `refusal_message` sits beside the decision, so neither door can
phrase the over-ceiling sentence differently:
"pub fn refusal_message(setting: &str, reason: BoundRefusal) -> String {"
(`crates/nostream-relay/src/relay.rs:163`).

`--check` prints it through the gate —
"            eprintln!(\"{}\", refusal_message(setting, reason));"
(`crates/nostreamd/src/settings_gate.rs:34`) — and `nostream-cli config validate`, the other
read-only door, appends the same strings to its verdict
(`crates/nostream-cli/src/config.rs:84-98`), from the same `refused_bounds` walk. The gate is not a
`tracing` line because `--check` returns before the subscriber exists: the gate writes outside the
filter by design (`crates/nostreamd/src/settings_gate.rs:8-17`), so the report is reached at the
shipped level.

**What a rejected document leaves to report, in the two mechanisms that actually apply.**

*Where `load` substitutes, there is no operator value left.* Four early returns replace the whole
outcome with the shipped defaults and set `used_defaults` — an unreadable user document, a document
the shape walk refuses, a typed document the fit refuses, and a read failure:
"    /// Whether the user's document was rejected and the defaults were substituted."
(`crates/nostream-config/src/load.rs:386`). A zero bound is now one of these: the document is
refused by the walk, so every surface prints the issue itself and nothing describes a bound,
because the gate will not walk a substitution —
"    if !outcome.used_defaults {" (`crates/nostreamd/src/settings_gate.rs:32`).

What each surface then does with the issue is **not one behaviour**, and the two start paths must
be read apart. Measured on `network: {frameMemoryBudgetBytes: 0}` with this build:

- **`nostreamd --check`** prints the issue, then `settings invalid: 1 issues`, and exits **2**. The
  gate's `check` branch returns before the continuation line:
  "    if check {" (`crates/nostreamd/src/settings_gate.rs:48`) →
  "        return Err(DaemonError::InvalidSettings {" (`crates/nostreamd/src/settings_gate.rs:49`),
  which `main` maps to "            ExitCode::from(2)"
  (`crates/nostreamd/src/main.rs:44`) after printing
  "            eprintln!(\"settings invalid: {count} issues\");"
  (`crates/nostreamd/src/main.rs:43`). It never prints the continuation line.
- **A normal start** (`nostreamd --config-dir <dir>`) prints the issue, then
  "        \"nostreamd: continuing on the shipped defaults ({} issue(s) in the user settings)\""
  (`crates/nostreamd/src/settings_gate.rs:54`), serves on the shipped defaults, and exits **0** when
  it drains — the same branch's "    Ok(())"
  (`crates/nostreamd/src/settings_gate.rs:57`) reaching the signal path, not an error. Measured
  on stdout: `INFO the acceptor is listening`, then `INFO drained; exiting`; exit code 0. (The
  port it names is the `--listen-port` it was given; the line is not a citation.)
- **`nostream-cli config validate`** prints the issue, then `settings invalid: 1 issues`, and exits
  **2** — the schema verdict, from its own `issues.is_empty()` branch, with no continuation line
  (`crates/nostream-cli/src/config.rs:93` and `:108`).

So a rejected document is fatal where a verdict is being asked for (`--check`, `config validate`)
and survivable where a relay is being started, and only the start path says it is continuing. All
four measurements are pinned (`check_refuses_a_zero_bound`, `config_validate_refuses_a_zero_bound`,
`a_zero_bound_is_an_issue_at_the_gate`, and the serving path's "    Ok(())" arm through that same
gate test's `check = false` call).

*Where nothing is substituted, there is a leaf to read and both doors read it.* With no user
document — a fresh install, a different `--config-dir` — `load` returns the shipped defaults with
`used_defaults` false, and with a valid document it returns the operator's typed settings. The
walk then reports the operator's over-ceiling values, and reports nothing when they are the
shipped ones: measured, `--check --config-dir <empty>` prints only `settings valid: 0 issues`,
exit 0, because `268435456` and `64` are inside the range.
`check_reports_nothing_for_the_shipped_defaults` pins the empty case.

What is deliberately unchanged: `--check` still exits 0 on an over-ceiling value it will replace,
since that is the policy for a valid key with an out-of-range value. A zero is not that case any
more: it is a schema fault, and a schema fault is fatal at both doors.

**What putting this beside the arithmetic costs, measured.** `nostream-cli` depends on
`nostream-relay` to reach `refused_bounds` and `refusal_message`, and that edge drags the websocket
and storage graph into a settings-check binary: `cargo tree -p nostream-cli --edges normal` is 469
lines with the edge and 177 without (reproduced by two lenses), and a cold
`cargo build -p nostream-cli --all-features` took **32.4 s without it and 87.1 s with it** — the
performance lens's measurement, taken on this host (single runs, shared host — direction, not a
ratio; an independent measurement by the code lens read 39.9 s and 96.7 s, so the direction is
agreed and the ratio is not). The alternative is to move the decision into `nostream-config`, which
would invert the dependency the bound's arithmetic lives behind (`RelayConfig` is
`nostream-relay`'s), so it is recorded rather than taken. #996 paid a second, smaller instance of
it: the zero rule lives in `nostream-config`, which reads the document and depends on nothing of
`nostream-relay`'s, and the ceiling stayed where its arithmetic is.

**The pair's real ceiling is not the cap's.** The budget is process-wide and the cap is per
address, so what the two bound together is `min(budget, addresses × cap × frame_queue_bytes)` — the
cap alone cannot be read as a memory ceiling, and the shipped `64 × 8 MiB` is one address's share,
not the process's.

**The guided catalogue still does not bound these two.** The catalogue has two validators —
"    SafeNonNegativeInteger," (`crates/nostream-config/src/guided.rs:25`) and `NonEmpty` — and
`SafeNonNegativeInteger`'s ceiling is the capture's maximum safe integer:
"        Ok(number) if number <= 9_007_199_254_740_991 => None,"
(`crates/nostream-config/src/guided.rs:77`). That is the capture's only number validator
(`src/utils/settings-guided-schema.ts` has one), so both entries carry it as its precedent
`network.maxPayloadSize` does, and an editor accepts about 9 exabytes of budget and about 9
quadrillion sockets — values the constructor then treats as the shipped default, at the operator's
console. A bounded-integer validator is the fix and is **not** in #996: the capture composes
its ceiling into the same primitive —
"  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER, 'Value must be a safe integer'))"
(`src/utils/settings-guided-schema.ts:31`) — so the change is a bound on one rule, with messages of
its own, and it belongs with the guided catalogue's unimplemented consumers rather than with these
two jobs. **The consequence is stated rather than hidden:** the editor's validator accepts a `0`
that the document validator refuses, so a `0` typed in the guided editor is saved and then reported
by both doors. That is the same gap, from the other side, and it closes when the bounded validator
lands. Both entries now state only the unit — "Frame memory budget (bytes)"
(`crates/nostream-config/src/guided.rs:210`) and "Max connections per IP (sockets)"
(`crates/nostream-config/src/guided.rs:273`) — because the `0 meaning the default` label #989 gave
them would now teach the opposite of what the file accepts.

**The cost, stated:** an operator who wants no budget has no way to ask for one, and this record is
the place that says so rather than a surprise at the console. That is the safe reading, not a
neutral one, and it is the reading the validator now enforces, so the refusal reaches the operator
as a named key and a non-zero exit rather than as a relay that quietly kept a bound they did not
want.
