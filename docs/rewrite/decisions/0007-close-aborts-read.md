# ADR 0007: A `CLOSE` aborts the read it closes (job 015)

- **Status:** accepted (job 015, Phase 2)
- **Deciders:** the maintainer, on the evidence in job 015's recon and the argument below
- **Date:** 2026-10-24

## Context

Two answers exist for a `CLOSE` whose stored read is still running. The port ends the read and
sends nothing further for the id (`crates/nostream-relay/src/handlers/unsubscribe.rs:3-7`); the
capture deletes the subscription row and keeps streaming
(`src/adapters/web-socket-adapter.ts:107-110`) — a deviation held without a record:

> The TypeScript tree is the specification. When Rust behaviour and a TS file disagree,
> the TS file wins unless a decision record says otherwise; the ADRs live in
> `docs/rewrite/decisions/` (`0001-runtime-and-telemetry.md` covers runtime, acceptor
> shape and telemetry) — read the relevant one before changing what it decided.
>
> — `CLAUDE.md:152-155`

A decision record is the mechanism that rule names, and this is one: the abort stands and the
capture's read is overridden for this message alone. ADR 0005 settled the invite emit
(`0005:136-149`) and deferred this question:

> Whether a plain `CLOSE` aborts a stored read is out of scope for this record; it is
> tracked as cameri/nostream#957.
>
> — `0005:212-215`

The behaviour pre-exists the record (`unsubscribe.rs:3-7`); nothing here changes code.

## A `CLOSE` aborts the read it closes

A `CLOSE` for a subscription whose stored read is still running ends that read: no further
stored `EVENT` and no `EOSE` for the id, and the subscription is gone.

It is the message's **prefix** on the connection loop, with no continuation
(`crates/nostream-relay/src/handlers/mod.rs:243-247`). The handler is two calls in order
(`crates/nostream-relay/src/handlers/unsubscribe.rs:14-16`): `abort_read`, which removes the id's
entry and signals it (`crates/nostream-relay/src/connection.rs:302-311`), then `unsubscribe`,
which drops the row (`:140-145`).

The read sees the cancellation before it opens the store — a `CLOSE` during the invite mint costs
no `find_by_filters` and no frame (`crates/nostream-relay/src/handlers/subscribe.rs:243-248`) —
and again on every loop turn and in its `select!`, whose cancellation branch returns before the
`EOSE` (`crates/nostream-relay/src/handlers/subscribe.rs:265-285`, `:273`). The removed row also
stops live delivery (`crates/nostream-relay/src/relay.rs:537`). The shape rejected here is removing
the abort to match the capture; §"The cost is parity, not correctness" prices it.

## The capture keeps streaming a read its client has closed

Its `CLOSE` handler emits one event, and that event's only listener deletes one map entry:

> this.webSocket.emit(WebSocketAdapterEvent.Unsubscribe, message[1])
>
> — `src/handlers/unsubscribe-message-handler.ts:9-11`

> this.subscriptions.delete(subscriptionId)
>
> — `src/adapters/web-socket-adapter.ts:107-110`

The read never consults that entry: its pipeline is a deleted-at filter, a tag-expiry filter, the
read-authorization guard and `isSubscribedToEvent`
(`src/handlers/subscribe-message-handler.ts:232-242`), a filter match —
`anyPass(map(isEventMatchingFilter)(filters))` (`:254-256`) — not a liveness check, while
`sendMessage` writes whatever it is handed to an `OPEN` socket
(`src/adapters/web-socket-adapter.ts:150-155`). The capture aborts reads, but `CLOSE` cannot
reach the machinery: `abortInFlightSubscriptionReads` (`:319-334`) is called only from
`endSubscription` (`:312-317`), which only a rate-limited `REQ` reaches (`:303`); the other path
is the socket closing (`:348-363`). So the client keeps getting the remaining `EVENT` frames
**and** the `EOSE` for an id it just deleted — read off the source, with no run.

## NIP-01 puts the bound on the abort's side

> `["CLOSE", <subscription_id>]`, used to stop previous subscriptions.
>
> — `nostr-protocol/nips` `0b5532c0355ab27f447e071a93c09cf3a2b4aad5`, `01.md:119`

> Upon receiving a `REQ` message, the relay SHOULD return events that match the filter. Any
> new events it receives SHOULD be sent to that same websocket until the connection is
> closed, a `CLOSE` event is received with the same `<subscription_id>`, or a new `REQ` is
> sent using the same `<subscription_id>` (in which case a new subscription is created,
> replacing the old one).
>
> — the same commit, `01.md:137`

NIP-01 is not vendored in this tree, so the citation is to the NIP's own text. `:119` says
what `CLOSE` is for; `:137` bounds what the relay keeps sending. A relay still delivering
stored events and an `EOSE` for that id is delivering for a subscription the client has
stopped, which is what the capture's read does.

## The cost is parity, not correctness

What was given up is byte-parity with the capture for a `CLOSE` that lands mid-read: the trailing
stored frames and the `EOSE` the capture would still deliver. Nothing a staying client sees was
given up, since the abort is confined to the id the client closed.

**A documented exception.** The rule is "the TS file wins unless a decision record says
otherwise" (`CLAUDE.md:152-155`), so a reader changing the handler must read this first.

**No oracle outside the socket tests.** No session closes mid-read, the double streams every row
unpaced (`crates/nostream-relay/tests/capture/gen-wire-sessions.mjs:205-212`) and no step key
holds a read open (`crates/nostream-relay/tests/wire_parity.rs:75-117`), so `wire_parity` cannot
see the difference. The pins are the socket test
(`crates/nostream-relay/tests/handlers.rs:1025-1050`), which asserts a 2-second silence
(`crates/nostream-relay/tests/common/mod.rs:156-164`) rather than "no frame ever", plus
`crates/nostream-relay/tests/connection.rs:621-662`, which covers the table entry.

**An abort is not a recall.** Frames already in `FrameSink` are written after the `CLOSE` is
handled. The queue is byte-bounded, with a drop-and-close policy on an unbounded channel
(`crates/nostream-relay/src/sink.rs:35-51`, `:77-125`): a frame that does not fit is dropped,
every later send too, and the loop closes the client and drains the queue
(`crates/nostream-relay/src/relay.rs:330-351`) without consulting the subscription table.
Whether a race shows a client a stray frame is **unmeasured** and no test exercises it — the
gated test holds the read before any record.

**What would reopen it.** A paced recording plus a replay step kind that releases the pace —
both halves, because a fixture alone passes for either implementation — or a measured capture
that aborts, or a NIP-01 change to `:119` or `:137`.

## What is pinned, and what the oracle cannot decide

The socket test gates the store read before any record (`:1029`; the gate is
`crates/nostream-relay/src/testing.rs:203-207`) and asserts no message within two seconds
(`:1041`). The registration assertion after `handlers::begin` returns `None` for a `CLOSE`
covers the table side: `read_in_flight("s1")` is false and no subscription remains. The one
census case for `test/unit/handlers/unsubscribe-message-handler.spec.ts`
(`crates/nostream-relay/tests/fixtures/ts-case-map.json:550-556`) maps to
`crates/nostream-relay/tests/connection.rs:65-78` — the table removal, its title the emit.

The three recorded sessions containing a `CLOSE` are `measured-session`, `rate-limit-message`
and `req-close-abort`: in `req-close-abort` the `REQ` expects `["EOSE","c1"]` and the `CLOSE`
`[]` (`crates/nostream-relay/tests/capture/gen-wire-sessions.mjs:811-818`), in `measured-session`
the `CLOSE` follows the `EOSE`, and in `rate-limit-message` the rate-limit `NOTICE` answers it.

Three structural reasons keep the replay from deciding it: the store double streams every row
with no pacing (`gen-wire-sessions.mjs:205-212`); a `{none: true}` step sends, waits 250 ms and
sweeps whatever arrived, recording post-`CLOSE` frames only if any are still to come (`:554-574`);
and the replay reads exactly `step.expect.len()` frames per step
(`crates/nostream-relay/tests/wire_parity.rs:409-430`) against a fixed key set (`:75-117`). It
would take a pace in the double plus a step kind that releases it, which is not this job.

## What this record does not decide

- **The invite `EVENT`.** ADR 0005 decides it (`0005:136-149`), and the two questions are
  independent: that emit's parity rests on `src/handlers/subscribe-message-handler.ts:111` and
  `:230`, not on whether the read aborts.
- **Whether a queued frame should be recalled.** No mechanism withdraws one; it stays unbuilt.
- **The `AUTH`-prefix strength and re-`REQ` read ownership**, both ADR 0005's and left unchanged.
- **A `CLOSED` frame on a client's own `CLOSE`.** Neither tree sends one; left as found.
