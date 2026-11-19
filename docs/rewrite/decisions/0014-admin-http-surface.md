# ADR 0014: The admin HTTP surface (job 032)

- **Status:** accepted (job 032, Phase 2)
- **Deciders:** the rewrite team, on the operator's decision recorded in #867 and this job's spec
- **Date:** 2026-11-19

## Context

Issue #867 bundles three deliverable families — the HTTP admin routes with the static console,
a `nostream-admin` MCP server, and a CLI port — and the operator's scope gate builds only the
first here. Its acceptance is the console: "the unmodified TS-era admin console performs every
action against the Rust relay". The console in this tree (`resources/admin` at `f01cb5f3`) is
six JavaScript files and a stylesheet, 3,346 JS lines, and it calls 26 API endpoints over 24
paths plus its own page and assets; `src/routes/admin/index.ts` registers 30 routes.

Before this job the crate was 576 lines of Phase-1 stubs: `routes::mount()` returned
`NotImplemented`, `ADMIN_ROUTES` mirrored the capture's 18 routes rather than the tree's 30,
and the daemon answered no HTTP request at all — a plain `GET` died in the WebSocket upgrade
(`crates/nostream-relay/src/relay.rs:315-329`), measured as `curl: (52) Empty reply from
server` on every admin path.

The eighteen decisions below are the ones a reader would otherwise have to reconstruct from
the diff. Each is recorded with its reason and the evidence that produced it.

## Decisions

### D1 — One listener, one port, dispatched by the peeked request head

`nostreamd` serves the WebSocket wire and the admin HTTP surface from the single `TcpListener`
it binds (R1). Each accepted socket's first bytes are **peeked**
(`tokio::net::TcpStream::peek`, never consumed) and classified
(`crates/nostream-relay/src/dispatch.rs`): a complete head carrying `Upgrade: websocket` goes
to `Relay::handle_socket`; every other complete HTTP head is served as HTTP/1.1 from the admin
router; a head that does not complete within 8 KiB or 1,000 ms goes to the relay, which is
today's path and the one a non-HTTP client has always taken. HTTP/2 cleartext is not served.

The capture serves both protocols from one Node server on one port
(`src/factories/worker-factory.ts:62-77`, `new WebSocketServer({ server })`). A second port
would change the console's URL, the session cookie's `Path` and the deployment story, and the
console at the base makes 26 calls that a mismatched port would break wholesale.

**The app-level connection rate limiter is not applied to HTTP.** `rateLimiterMiddleware`
destroys the socket on limit (`src/handlers/request-handlers/rate-limiter-middleware.ts:11-28`)
and a browser cannot tell that from a network error; the console's own admin limiter (30 per
minute, Value 4) already bounds its traffic, which is about one request per 30 s plus clicks.

Peeking leaves the stream untouched, so the relay's upgrade path reads the bytes it would have
read without this module in the way; the relay's own tests (`tests/wire.rs`,
`tests/acceptor.rs`) start the relay-only path and pass unchanged.

### D2 — Redis-held admin state becomes process-local in `AdminState`

ADR 0010 deleted the cache and assigned exactly these consumers here
(`0010-services-worker-model-and-cache.md`): the admin ops heartbeat and config to #867, and
NIP-98 replay plus the audit log to the admin job. This job's `AdminState` therefore keeps, in
process:

- the worker-heartbeat table, published by the daemon (`maintenance` at start and every 45 s);
- the probe snapshot and its bounded history ring, honouring
  `nip66.historyRetentionRuns`/`historyRetentionHours`;
- the admin audit log, as the JSONL file D9 decides.

A restart resets the first two. That is correct for a single-process daemon rather than
lossy: the capture's heartbeat and probe rows lived in Redis, which a restart of the Redis
container also emptied for the same kind of information.

**Moderation rate-limit hits are not counted at all** — D4's reason: there is no hit counter
to read, and inventing one would be the "plausible fake data" the porting discipline forbids.

### D3 — `/network-health/run` is wired, and answers `502` because the probe is #865's

The probe primitives are labelled Phase-2 stubs for #865
(`crates/nostream-services/src/monitor.rs`). The route therefore reproduces every status the
capture's controller states — `409 NIP-66 monitoring is disabled` when `nip66.enabled` is
false, `400 No valid probe targets configured` with the invalid list when no target parses as
a `ws`/`wss` URL, `502 Probe run produced no results` when a run is configured and valid — and
`GET /network-health` answers `{"snapshot":null}` while `GET /network-health/history` answers
`{"runs":[]}`, which are the states the console renders. `AdminState` carries the ring and the
latest snapshot so #865's run lands in the shape the console reads, with no change to the
route.

### D4 — `/moderation/stats` returns the full shape with empty aggregates

`topPublishingPubkeys: []`, `topClientIps: []` and `rateLimitHits: {pubkeys: [], ips: []}`,
with the query validation and its `400` message intact (`windowHours` in `[1, 720]`, default
168; `limit` default 20). The capture aggregates over Postgres and Redis
(`src/utils/admin-moderation-stats.ts:52-80`); `EventRepository` has `count_by_filters` and no
grouped aggregation, and there is no hit counter. Adding either belongs with the store's
query surface, not with a route.

### D5 — `/metrics` serves the capture's own `unavailable` snapshot

The TypeScript snapshot is assembled from Prometheus queries
(`src/utils/admin-metrics.ts:27-35`, `PROMQL`) and the Rust process has neither a Prometheus
endpoint (`crates/nostreamd/src/telemetry.rs` is OTLP only) nor accepted/rejected or
connection counters anywhere in `nostream-relay`. What the stream carries is the shape the
capture itself emits when collection fails — `createUnavailableAdminMetricsSnapshot`
(`:52-64`): `status: "unavailable"`, the seven numeric keys the console reads at zero, the real
health objects, and `prometheus {available: false, error}`. The console's `updateSnapshot`
(`dashboard.js:1597-1634`) renders any parsable object, so the metrics strip shows its
unavailable state instead of an error banner.

The interval is the capture's: `ADMIN_METRICS_SSE_INTERVAL_MS`, values under 1,000 ms falling
back to 5,000 (Value 27), resolved by the composition root and pinned by
`utils::metrics::resolve_interval`'s tests.

### D6 — NIP-98 is not an authentication path in this slice

The capture's two middlewares accept a session cookie **or** a NIP-98 `Authorization: Nostr`
event, the full one binding the body and claiming the event id against replay
(`src/handlers/request-handlers/admin-auth-middleware.ts:39-154`). The console authenticates
with a cookie only, and `nostream_core::nip98::verify` is a Phase-1 stub
(`crates/nostream-core/src/nip98.rs:20-31`), so the gate would be a fake. No `Authorization:
Nostr` branch exists; a request without a valid session is always
`401 {"error":"Unauthorized"}`, whatever the `admin.nip98` settings say.

### D7 — `AdminState` takes the repository handles from the existing `ServiceStores` bundle

The daemon already builds `Arc<ServiceStores>` for the relay and the services
(`crates/nostreamd/src/main.rs`); the admin surface is handed the same `Arc` rather than a
second bundle. The event store, the NIP-05 verifications, the notification outbox and the
delivery log are the four it reads, and every one of them is a field of that struct. The
oracle test builds the bundle over `LmdbBackend::open(tempdir)`, which implements every trait
the bundle needs (`crates/nostream-storage/src/lmdb/mod.rs:481,664,734,805,1027,1074`).

A consequence, stated so it is not read as a defect: the daemon still wires
`unavailable::stores()` (the store is not wired into `nostreamd` yet), so a storage-backed
route answers `500` in the daemon until that job lands. The oracle proves those routes against
a real LMDB store; the daemon's composition is what changes when the store is wired.

### D8 — Settings are read per request and written through a `nostream-config` store

The capture's `createSettings()`/`loadMergedSettings()` re-reads the files on every call
(`src/utils/settings-config.ts:458-485`), and a per-request read makes the console's own view
correct after a `PATCH` with no shared mutable cache to invalidate. Writes go through the new
`nostream_config::store` module — save-with-backup, list, restore, the defaults filter and the
settings-audit append — which is the only place in the tree that writes a settings file.
Applying a hot reload to a running subsystem from a PATCH is out of scope: the relay has no
reload seam, and the `reload` class the console prints (`restart-required` for `workers.`,
`payments`, `network.`, else `hot-reload`, Value 15) is reported faithfully rather than acted
on.

### D9 — The admin audit log is its own JSONL file

`<config>/admin-audit.jsonl`, holding `{id, at, action, remoteAddress?, detail?}` and capped
at the newest 2,000 entries. The console renders `entry.at`, `entry.action` and
`entry.remoteAddress` (`admin-trust.js:91-97`), and the settings audit's lines carry
`timestamp` and a different body (`src/utils/settings-config.ts:549-556`), so one file cannot
serve both; the settings audit stays `<config>/settings-audit.jsonl`, where the capture writes
it. ADR 0010 assigns the audit log to this job with no Redis, and the file is the replacement.

### D10 — The prefix comes from `info.relay_url`; the scheme and address are per request

The mount point is fixed when the router is built, so it can only come from a value known
then — `info.relay_url`'s path, trailing slashes dropped (Value 46). `X-Forwarded-Prefix` is
**not** honoured: a page whose scripts were rewritten for a prefix the routes are not mounted
at would `404`, and the capture's own trusted-proxy branch
(`src/utils/http.ts:96-118`) has the same hazard behind a proxy that sends a different prefix
than the operator configured.

`X-Forwarded-Proto` **is** honoured, for the session cookie's `Secure` flag, and the client
address for the rate-limit keys, both gated on `network.trustedProxies` and read per request
(Values 47, 49). Neither has a routing consequence.

The narrowing this job takes: an `npub` in a moderation action's `pubkey` is refused with the
capture's message, because this tree has no bech32 decoder and the relay already refuses the
same form for the same reason (`crates/nostream-relay/src/handlers/subscribe.rs:152-153`).

**A relay-path change leaves the page and the cookie ahead of the mount, and that is the
capture's behaviour** — adjudicated 2026-11-19, not fixed. When `info.relay_url`'s path moves
from `/old` to `/new` without a restart, the next page render points its scripts at
`/new/admin/assets/…` and a login or logout sets the cookie's `Path` to `/new/admin`, while the
router stays mounted under `/old/admin`; the console then fails to load until the process
restarts. The capture does exactly this: the page's prefix comes from the settings read at
request time (`src/handlers/request-handlers/get-admin-dashboard-request-handler.ts:19`,
`getPublicPathPrefix(req, currentSettings)`), the cookie's `Path` likewise
(`src/utils/admin-session.ts:27,34`), and its router is mounted once when the app is built
(`src/routes/index.ts:38` → `src/factories/web-app-factory.ts:51`). Pinning the page and the
cookie to the mount-time prefix here would be a second convention for the same value, and the
console's recovery — a restart — is the one the operator already knows from the capture. The
same `info.relay_url` edit therefore keeps this record's rule rather than gaining a new one.

### D11 — The oracle derives its routes from the console and speaks HTTP/1.1 by hand

`crates/nostream-admin/tests/console_parity.rs` reads `resources/admin/assets/*.js` at test
time and derives the endpoint set from `${adminBase}` interpolations and `adminFetch(…)` calls:
26 `(method, path)` entries over 24 paths, the two page routes and the seven asset names the
template loads. Every derived route is then driven against a live in-process server. A route
deleted from `mount()` fails the run with a non-empty `unserved` list rather than passing on a
hand-copied table that was edited in step with the router.

The client is a hand-written HTTP/1.1 request over `tokio::net::TcpStream`: `reqwest` is
confined to `nostream-services` (`CLAUDE.md`), and status, headers and a streamed body are all
the parity check needs.

### D12 — No browser automation; the browser pass is the operator's check

`package.json` has no playwright, puppeteer or jsdom, and no browser CI job exists. Adding one
is a second, larger commitment than this slice, so the reachable proof is the route-level
oracle and the browser walkthrough is the operator's judged criterion (AC26).

### D13 — `nostream-admin` builds a `Router`; only `nostreamd` binds

`nostream_admin::routes::mount(state)` returns an `axum::Router`; the daemon serves it from the
listener the acceptor owns. This keeps `nostreamd` the only crate that opens a socket, so the
instruction file's rule ("`nostream-services` is the only crate that opens sockets and child
processes … Nothing else may take those features") needs no amendment, and the argument holds
without one: a library that bound a port would make the rule false. Test targets bind
`127.0.0.1:0` themselves, which is a test's business and no library's.

### D14 — The admin limiter is the tree's limiter, not a third store

`utils::rate_limit` calls `AdminState::hit_rate_limit`, which runs
`nostream_relay::limits::RateLimiter` — the port of the capture's
`src/utils/ewma-rate-limiter.ts`, `sliding-window-rate-limiter.ts` and `rate-limiter-factory.ts` —
behind the `Limiter` trait. `limits.rateLimiter.strategy` selects EWMA (the factory's default) or
the sliding window per request, and a change to that setting swaps the store, so the switch is
live rather than a dead branch.

The first cut kept a private `HashMap<key, VecDeque<instant>>` in `AdminState`. It was wrong in
three ways the shared type cannot be: it recorded refused hits (EWMA stores the new rate before
the verdict, the sliding window records only allowed ones), it never evicted a key (the shared
store caps at `MAX_STORE_KEYS` = 65,536 and sweeps on admit), and it hard-coded one strategy while
the capture selects one from settings. **The lesson is the shared type**: the two strategies
exist behind one trait, and what confines the rule is the concrete `RateLimiter` that
`from_settings` builds — the trait alone admits any implementor (the test double implements it),
so a private store could still have been written beside it. Taking the concrete shared limiter is
what makes the store's own refusal rule the only reachable one.

The architecture review asked for the tree's already-ported limiter to be used instead of the
private store (the sliding window existed at the base — `limits.rs`, `struct
SlidingWindowRateLimiter`; no lens asked for it to be ported). The operator ruled for the shared
EWMA as the default ("I don't think we need to port the sliding-window, the EWMA is superior"),
with the settings switch keeping the sliding window selectable, as the capture's factory offers
both. This is his decision, recorded as his.

The refusal rule follows the capture's limiter, not the sliding window's: a refused hit **does**
advance the rate, and a key past `ceil(period / 1000)` s starts fresh. `tests/rate_limit.rs`
proves both (`a_refused_hit_advances_the_rate_and_a_stale_key_starts_fresh`) and proves the
strategy switch (`the_settings_select_the_strategy`: at 59 s the EWMA rate has decayed below the
limit while the sliding window still holds its hits).

### D15 — Login verification runs on the blocking pool, capped

`POST /admin/login` is the one admin route that does heavy CPU work: scrypt, measured at 1.77 s
per attempt in the dev profile. `AdminState::verify_admin_password` moves it to
`spawn_blocking` behind a `Semaphore` of `MAX_CONCURRENT_LOGIN_VERIFICATIONS` (4), so a burst of
logins queues instead of taking the runtime workers that also serve the wire. The `ADMIN_PASSWORD`
override stays a byte compare on the request path — it is what the capture checks first, and it
is cheap.

`crates/nostreamd/tests/admin_http.rs` proves the point on the real binary: a `GET /admin/session`
answers while a login verification is still in flight.

### D16 — The admin audit log appends, and compacts over the cap

`append_audit` is `OpenOptions::append` and one `write` per request; the 2,000-entry cap is kept
by a compaction that runs once per `AUDIT_COMPACT_EVERY` (2,000) appends, reading once and
renaming a fresh file into place.

The first cut read, parsed and rewrote the whole file under a mutex on every call — and an
unauthenticated `POST /logout` reaches it, so any caller could drive a full-file read and rewrite.
Measured on the `audit` target's cap case (2,000 appends at a full file): **34.5 s** before,
**0.29 s** after under strace; per append one `openat` and one `write` instead of a whole-file
read and write.

### D17 — The storage-count route keeps the capture's one deadline over concurrent queries

`GET /ops/storage/counts` issues its ≤20 per-kind queries as futures and gathers them under one
5,000 ms `timeout`, which is the capture's `Promise.all` shape and keeps the single `504` the
route states. The LMDB backend's `count_by_filters` may complete synchronously inside its future,
in which case the gather buys nothing on that backend and costs nothing; it is the Postgres
backend, whose query is a real await, that the shape is for.

### D18 — The audit vocabulary gains one `mcp.*` action per tool

The MCP server writes its calls to the same `<config>/admin-audit.jsonl` (D9), one line per
executed call, and it extends the recorded action vocabulary by **four names** rather than
reusing one:

| action | written by |
|---|---|
| `mcp.settings_get` | a dispatched `settings_get` |
| `mcp.settings_set` | a dispatched `settings_set` |
| `mcp.list_events` | a dispatched `list_events` |
| `mcp.get_event` | a dispatched `get_event` |

**These extend the capture's nine names; they do not replace them.** The capture's vocabulary is
a closed nine-name union (`src/@types/admin-audit.ts:1-10`), and the rewrite's writer takes
`&str` (`crates/nostream-admin/src/state.rs:497`), so a new name is accepted and stored without
a schema change. Each name is `mcp.` plus the tool's own name, and each is a named constant in
`crates/nostream-mcp`.

**One name per tool, not one `mcp.tool_call` with the tool in `detail`.** The console's trust page
renders `entry.action` verbatim (`resources/admin/assets/admin-trust.js:93`), so the action column
is the only place an operator reads *which* surface did what without opening the entry: a single
`mcp.tool_call` would print the same words for four different operations and push the distinction
into a field the page does not show. The cost is one more line in this record; the alternative
costs the column its meaning.

**What each line carries.** `detail` holds `{"tool": "<name>"}`, plus `{"paths": [...]}` for
`settings_set` (the paths requested, never a value), and `remoteAddress` is omitted because a
stdio caller has no address (`state.rs:509-525`). The line is appended at dispatch, before the
tool's work, so the file's order is the dispatch order: `mcp.settings_set` precedes the
`settings.updated` line the shared write path then appends, and a call the credential gate
refuses appends nothing at all — matching `admin_auth_middleware.rs:52-63`, which logs a warning
and writes nothing.

**The mode is its own process, and the record says so.** `nostreamd --mcp-stdio` returns before
the daemon's `serve` loop starts (`crates/nostreamd/src/main.rs:135-141`), so the process that
serves a tool call composes its own `AdminState` over the same config directory rather than
sharing the console's: the two modes are alternatives, and running both against one directory is
outside ADR 0012 D9 — `admin-audit.jsonl` (whose compaction is a read, a write and a rename on a
shared staging path, `crates/nostream-admin/src/state.rs:715-733`) and the settings write both
assume one writer per configuration.

**The audit table is total.** Every tool the router registers has its own entry in
`crates/nostream-mcp`'s `TOOL_ARGUMENTS` table, and the dispatch path looks a name up there
instead of defaulting: a tool added without an entry fails
`every_registered_tool_is_in_the_audit_table`, which reads the router's own list, so no call can
execute unaudited. "One line per executed call" therefore means what it says — a call whose
arguments do not parse and a call to a name the router does not register reach no tool and write
nothing, and every other call writes its line before the handler runs.

## Evidence

Measured in this job's worktree at `factory/032-admin-console-parity`:

| what | command | result |
|---|---|---|
| the route set is the console's | `cargo test -p nostream-admin --test console_parity -- --nocapture` | `derived: 26 calls over 24 paths + 2 page + 7 assets`, `unserved: 0` |
| the disabled surface | `cargo test -p nostream-admin --test surface` | `1 passed`, `404 text/plain "Not Found"` on every route |
| the session model | `cargo test -p nostream-admin session` | `8 passed` |
| the limiters | `cargo test -p nostream-admin --test rate_limit` | `4 passed` |
| the 26 shapes | `cargo test -p nostream-admin --test route_shapes` | `26 passed` |
| the capture's messages | `cargo test -p nostream-admin --test query_limits` | `0 failed`, 27 cases |
| the settings writer | `cargo test -p nostream-admin --test settings_routes` | `0 failed`, 13 cases |
| the SSE stream | `cargo test -p nostream-admin --test metrics_sse` | `1 passed` |
| the page and assets | `cargo test -p nostream-admin --test dashboard` | `7 passed` |
| one port, in the binary | `cargo test -p nostreamd --test admin_http` | `1 passed`: HTML page, `401` session, NIP-42 challenge on the same port |
| the wire is unchanged | `cargo test -p nostreamd --test wire --test acceptor` | every case passing |
| one limiter, live switch | `cargo test -p nostream-admin --test rate_limit` | `6 passed`: 31st admin / 11th login refused under EWMA; `the_settings_select_the_strategy` splits EWMA and the sliding window at 59 s |
| the audit append is O(1) | `cargo test -p nostream-admin --test audit`, `strace -c` on the cap case | 2,000 appends at a full file: 34.5 s → 0.29 s; `3,477 reads`/`1,730 writes` → `29 reads`/`2,014 writes`; cap still 2,000 |
| a login does not stall the listener | `cargo test -p nostreamd --test admin_http` | `2 passed`: `/admin/session` answers while the verification is in flight |

## Assumptions

1. The oracle console is the tree at the job's base `f01cb5f3` (operator decision). The capture
   commit `041fe34e` remains the semantic reference for the 18 capture-era routes.
2. `docs/rewrite/decisions/` carried two `0012` files when this record was written; the
   duplicate is renumbered by the job that owns it, and this record is `0014` on the primary's
   ruling of 2026-11-19. No existing record is renamed or edited here.
3. The settings document is written with `serde_yaml`; the capture's `yaml.dump` layout is not
   reproduced, and the console re-reads through the server, so the file's meaning is the
   contract.
