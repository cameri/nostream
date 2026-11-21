# ADR 0016: The relay status document, the `relay_status` tool and the NIP-11 field set

- **Status:** accepted (job 035, Phase 2)
- **Deciders:** the rewrite team, on the operator's steer recorded in #1183 and this job's spec
- **Date:** 2026-11-21

## Context

Slice 2 of #1183 is one MCP tool, `relay_status`: the software version, the relay process's
uptime, its live connection count, its worker rows, and the NIP-11 document it advertises. Two
facts at the base commit shaped it.

**The tool answers in a process that hosts no relay.** `nostreamd --mcp-stdio` returns before
the daemon's `serve` loop starts, and the process that serves a tool call holds no `Relay`, no
`ConnectionCap` and no heartbeat publisher (`crates/nostreamd/src/mcp_stdio.rs`,
`crates/nostreamd/src/main.rs`). Heartbeats are process memory
(`crates/nostream-admin/src/state.rs`) and `AdminState` holds no relay handle. A payload built
only from the MCP process would therefore report the *MCP process's* age as the relay's uptime,
every monitored worker row as stale, and no connection total at all — three wrong facts wearing
the relay's name, which is worse than a stub.

**No connection total existed anywhere.** `ConnectionCap` exposed `max_per_ip`, `live(ip)`,
`tracked_addresses()` and `refusals()`, and its map is private: the sum was not reachable from
outside. ADR 0014 D5 records the absence, and `crates/nostream-admin/src/utils/metrics.rs` serves
`activeConnections` as the literal `0` — that key name is the console's and this job keeps it.

The NIP-11 document did not exist either: `docs/rewrite/nip-parity.md` §10 D1 said so, and its
§9 item 11 deferred the field set to "with the document". This job is the document.

## Decisions

### D1 — The daemon publishes a status document; the tool reads it

`<config>/relay-status.json` is written by one task in the daemon
(`nostreamd::admin_http::publish_status`, spawned in `serve`) and read per call by the tool
(`nostream_admin::utils::status::read`). The file is `StatusDocument`: `generatedAt`,
`uptimeSeconds`, `activeConnections`, `workers`.

The pricing is part of the decision: **one** writer task, a **5 s** cadence
(`STATUS_INTERVAL`), a **30 s** staleness bound (`STATUS_TTL_SECONDS`), an **atomic replace** (a
sibling `.tmp` write and a rename, so no reader sees a half-written document and no `.tmp`
survives a successful write), and a `reason` on every unavailable value. The cadence is six
times faster than the bound, so one missed write is still fresh; 5 s is the coarsest cadence that
makes a connection count worth reading.

The payload has exactly two sources: `version` and `nip11` come from the answering process, and
everything under `relay` comes from the published document. **Unavailable is never zero.** With
no document, an unreadable one, or one older than the bound, `relay` is
`{reason, observedAt: null, ageSeconds: null, uptimeSeconds: null, activeConnections: null,
workers: null}` and the reason names `relay-status.json`; a `0` in the payload can only come from
a document that says `0`.

**Cost:** the numbers are up to 5 s old, and a daemon that stops writing is reported as
unavailable after 30 s rather than as stale numbers. The alternative — a route on the daemon's
listener — would need D1's HTTP surface and an auth model; the file is the cross-process channel
the tree already relies on (`admin-audit.jsonl`), with no new surface.

**Reading it is not ADR 0014 D18's second-writer hazard.** D18 records that
`admin-audit.jsonl` and the settings write assume one writer per configuration. This file is one
writer (the daemon) and one reader (the MCP door); the MCP mode never writes it, and D18 is
amended to say so.

### D2 — The seam is two concrete places, not a trait

The tree's trait seams invert a dependency: `nostream_relay::dispatch::HttpFallback` and
`nostream_relay::wot::WotGraph` are declared in a lower crate because their implementations can
only live in a higher one. Neither condition holds here — `nostream-mcp` already depends on
`nostream-admin`, which already depends on `nostream-relay`, and the daemon already holds the
type that produces the count. A trait would be an abstraction over one implementation and would
add a field to `AdminStateConfig` at every construction site.

So the seams are:

1. `ConnectionCap::live_total(&self) -> usize`, the sum of the guarded map under the same
   poison-tolerant lock the three existing accessors take — one lock acquisition per read,
   O(addresses), the shape of `tracked_addresses()`. `live(ip)`, `tracked_addresses()` and
   `refusals()` keep their signatures and behaviour.
2. The published document above.

**Cost:** `live_total` is a second lock acquisition where an `AtomicU64` maintained in `acquire`
and in `ConnectionSlot::drop` would be lock-free. The counter was rejected because it adds a
second place that must stay in step with the map, and the total is read once every 5 s.

### D3 — The document's four keys, and the console's worker rows verbatim

`StatusDocument` is `generatedAt`, `uptimeSeconds`, `activeConnections`, `workers`, camelCase
because `uptimeSeconds` and `activeConnections` are the console's own names. Its `workers` is
`Vec<nostream_admin::utils::workers::WorkerRow>` — the rows `GET /ops/workers` already serves,
produced by `workers::rows` — so there is no second staleness judgement: a stale row reads
`stale: true` with an old or absent `heartbeat`, and the tool adds nothing. `WorkerRow` and
`WorkerHeartbeat` gained `Deserialize` so the reader validates a document rather than trusting
it; no serialized field changed.

`collect` assembles the document from the implementations that already exist and nothing else:
`AdminState::uptime_seconds`, the state clock through `iso8601`, and `workers::rows`. It computes
no staleness of its own.

**Cost:** a row's shape is the console's, so a change to `WorkerRow` moves the document too. That
is the point: one array, one judgement.

### D4 — The NIP-11 field set, per key (closing `nip-parity.md` item 11)

`nostream_relay::nip11` builds the document; every key's presence is decided in that module.
The rule where the capture and an `11.md`-less extension disagree is **advertise what the relay
enforces**.

Kept, with their sources: `name`, `description`, `contact` (`Info`); `banner`, `icon`,
`terms_of_service` when set; `pubkey` as hex (an `npub1…` decoded, as the capture does); `self`
when resolved (`info.self` when it parses, else the signing key); `supported_nips`; `software`
(the workspace repository, `env!("CARGO_PKG_REPOSITORY")`); `version` (the caller's);
`limitation.max_message_length` (the transport's own `max_payload_size`); the five client limits
and `max_content_length` when set and, for the client limits, non-zero (`0` means "no cap" to the
checks that read it, and would read as "none allowed"); `min_pow_difficulty` when non-zero;
`auth_required` as the literal `false` (the capture's deliberate split: publish-only AUTH is
`restricted_writes`); `payment_required` when payments are configured; `created_at_lower_limit`
and `created_at_upper_limit` when set; `default_limit` (`nostream_storage::DEFAULT_PAGE_ROWS`);
`restricted_writes`; `search_supported`; `fees.admission` and `fees.publication`.

The seven drops, with their reasons:

| key | why it is dropped |
|---|---|
| `supported_nip_extensions`, `supported_mips` | no Rust source at all (the capture's `package.json` is the only place they exist), and neither name is in `11.md` |
| `payments_url` | the route it names does not exist: `crates/nostream-admin/src/routes/` registers no `invoices` route, and D1 keeps a public HTTP surface shut |
| `peering` | no Rust code serves peer feeds; `peering` appears only in the settings type and the validator |
| `limitation.min_prefix` | `min_prefix_length` is read nowhere in `crates`; the wire's floor is the fixed 4 of `validate_prefixes`, and `nip-parity.md` item 8 already records that it is not advertised |
| `limitation.max_event_tags` | no Rust constant and no admission check anywhere; the audit's own rule is to enforce it or not advertise it |
| `fees.subscription` | no invoice route and no subscription enforcement; it lands with them |

`nostream-cli info` does **not** adopt the builder in this slice: its nine lines and its `--json`
object are pinned byte for byte by their own cases, and it carries no NIP-11 document, so
adopting the builder would change its output contract — an unpriced change. The builder lands in
`nostream-relay`, which the CLI already depends on, so the adoption is a later job's one-line
change with no new dependency edge.

**Cost:** a client that read `max_event_tags` from the capture's document no longer sees it. The
alternative is a document that promises a limit the relay does not keep.

### D5 — `supported_nips` is `SUPPORTED_NIPS` minus what does not run

`SUPPORTED_NIPS` in its own order, minus `43` when `nip43.enabled` is not true, minus `50` when
`nip50.enabled` is not true, and minus `77` always — its handler is a stub
(`crates/nostream-relay/src/connection.rs`). This closes the audit's recorded inconsistency
("50 is supported" and "search is off") from the other side: with NIP-50 off, neither the id nor
`search_supported: true` is advertised.

**Cost:** the advertised list now depends on settings, so two relays on one binary can advertise
different sets. That is what the switches mean.

### D6 — `restricted_writes` folds the arms the event handler enforces; three capture surfaces stay out

`restricted_writes` is a pure fold over the settings whose every arm has an enforcing site in
`crates/nostream-relay/src/handlers/event.rs`: an enabled admission fee schedule under
`payments.enabled`; `nip43.enabled`; `nip42.authRequired == Some(true)`; a non-zero
`eventId.minLeadingZeroBits`, `pubkey.minLeadingZeroBits` or `pow.enabled`; a non-empty pubkey
whitelist or blacklist; a non-empty kind whitelist or blacklist.

The capture's **subscription arm is not ported**, because nothing in the rewrite enforces
subscriptions: a configured plan does not make `restricted_writes` true. For the same reason
`fees.subscription`, `payments_url` and `peering` stay out (D4): each describes a surface or an
enforcement this relay does not have.

**Cost:** an operator who configured subscription plans sees a document that does not mention
them. When the invoice routes and subscription enforcement land, all four arrive together.

### D7 — The shapes are the console's, not the CLI's

- `uptimeSeconds` is a number — `HealthSnapshot`'s name and type — and it is the **relay
  process's** age, from `AdminState::uptime_seconds`. `nostream-cli info`'s own uptime comes
  from `docker inspect` and describes the container; the two need not agree, and neither changes.
  `format_uptime`'s `Nd Nh Nm Ns` string stays a CLI rendering.
- Worker health is the console's `WorkerRow` array (D3), with no second staleness judgement.
- `activeConnections` is the console's key name, and the value is `ConnectionCap::live_total()`:
  sockets, not addresses. `/metrics`' own `activeConnections` stays the literal `0` D5 recorded;
  re-wiring it is a separate change with its own surface.
- The payload is `structuredContent` only, `version` is the composition's (`serverInfo`'s, never
  a crate-local `env!`), and `nip11` is the document of D4 serialised as it stands.

**Cost:** the tool's payload and the console's rows share a type, so a field added to one is
visible to the other. That is the alternative to a second row shape, and it was chosen.
