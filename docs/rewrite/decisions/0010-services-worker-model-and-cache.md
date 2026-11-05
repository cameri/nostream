# ADR 0010: Services, the worker model and the cache (job 023)

- **Status:** accepted (job 023, Phase 2)
- **Deciders:** the rewrite team, on the operator's decisions recorded in #866 and this job's spec
- **Date:** 2026-11-05

## Context

Issue #866 asks for the six services and the worker model, and it offers one decision
explicitly: keep Redis as the cache, or decide embedded and record why. Three smaller
divergences came out of the same work — the meaning of `WORKER_COUNT`, the Tor port spec,
and the transaction the capture wraps `createInvoice`/`confirmInvoice` in. This record
answers all four so a later reader does not have to reopen #866 to know what the Rust side
chose.

## Decisions

### D1 — No Redis client is added; the cache is embedded

The capture's adapter offers fifteen operations — strings, sorted sets, hashes, sets and
`eval` (`src/@types/adapters.ts:33-49`, `src/adapters/redis-adapter.ts`). None is ported.
`crates/nostream-storage/src/cache.rs` is deleted, and the storage crate's module doc moves
`src/cache/client.ts` and `src/adapters/redis-adapter.ts` to "deliberately does not own".

The request's premise is that the cache "is load-bearing for rate limits". In this tree it
is not: both limiters are in-process stores, documented as such
(`crates/nostream-relay/src/limits.rs:6-13`), and the wire path never consults Redis. The
surviving consumers and their owners are:

| consumer | capture | owner here |
|---|---|---|
| rate limiters | `src/factories/rate-limiter-factory.ts:11-22` | already in-process (`nostream-relay::limits`) |
| web-of-trust follow sets | `src/services/wot-graph-service.ts:78-80,193,208` | this job, in a process-local map (D2) |
| NIP-66 bootstrap key | `src/services/nip66-event-publisher.ts:86,105-109` | #865 |
| admin ops heartbeat and config | `src/factories/admin-ops-cache-adapter-factory.ts` | #867 |
| NIP-98 replay and the audit log | `src/utils/nip98-replay.ts:13`, `src/utils/record-admin-audit.ts:5-8` | the admin job |

**What would overturn it:** a multi-process deployment of this daemon, or #865/#867 needing
to share state across hosts. The seam then is a backend beside the repository traits, not
fifteen operations copied from the adapter.

### D2 — The web-of-trust adjacency is process-local

`WotGraphService` keeps the follow sets and the distance map in `HashMap`s behind one
`Mutex` (`crates/nostream-services/src/services/wot_graph_service.rs`). It still falls back
to the newest kind-3 event through `EventRepository::find_by_filters` for a pubkey whose set
is empty, which is exactly the capture's `cached.length` test, so the observable behaviour
is the same; only the store of the cached sets moved. The rebuild is fire-and-forget behind
a single-flight guard: a trigger during a build queues one more pass.

**What would overturn it:** a second process needing the same graph (D1's trigger).

### D3 — `workers.count` and `WORKER_COUNT` select runtime threads

`WORKER_COUNT` exists to fork N socket processes in the capture. The Rust acceptor serves
every connection as a task, so the count is parallelism: the runtime is built with
`WORKER_COUNT` when it parses to a positive integer, else `settings.workers.count` when it
is non-zero, else `std::thread::available_parallelism()`
(`crates/nostream-services/src/scheduler.rs::resolve_worker_count`, called from
`crates/nostreamd/src/main.rs`).

The capture reads `Number(WORKER_COUNT || workers.count) || cpus().length`
(`src/app/app.ts:107-109`). `Number("abc")` is `NaN`, so an invalid value reaches
`cluster.fork` as a NaN count — in practice a primary that forks no client worker and
accepts nothing. Reproducing that in tokio would mean a runtime with zero worker threads.
This rewrite instead falls through to the settings value and then to the CPU count. A
non-numeric, `"0"` or `"-1"` `WORKER_COUNT` is therefore a **deliberate divergence**, and
the fall-through is what the scheduler tests assert.

**What would overturn it:** a decision to reject a bad `WORKER_COUNT` at startup rather than
ignore it. That is a refusal, not a fall-through, and it changes the daemon's exit code.

### D4 — Respawning and draining are the capture's values

A worker whose future returns `Err` is restarted after 10 000 ms unless draining has begun,
and the restart is logged with the worker name and attempt number. A worker whose future
returns `Ok(())` has finished its work and is not restarted. On `begin_draining` no further
restart happens, the supervisor waits at most the drain deadline, and workers still running
are aborted with one `tracing::warn!(remaining, "terminating workers after the drain
deadline")` (`src/app/app.ts:250-267,269-312`).

The drain deadline is `WS_DRAIN_TIMEOUT_MS` (default 30 000 ms) + 5 000 ms — the capture's
`getPrimaryShutdownDeadlineMs()` (`src/utils/shutdown-state.ts:1-2,31-33`), the same
`drain_timeout()` the relay reads (`crates/nostream-relay/src/transport.rs:32,100-125`).
Both the restart delay and the deadline are constructor parameters with these defaults so a
test can inject milliseconds instead of minutes (the seam `HiddenContentCache::start`
already uses).

**What would overturn it:** a deployment whose drain takes longer than 35 s, which is an
operator value and would become a setting rather than a constant.

### D5 — One store bundle, resolved once, shared by every worker

The capture resolves `eventStore.backend` once in the primary and passes it to each forked
worker, which resolves it again from the inherited environment
(`src/app/app.ts:118-137`, `src/utils/event-store.ts:7-32`). A single-process daemon has one
resolution to make, so `serve` resolves `storage::event_store::resolved_backend` once, logs
it, and shares one `ServiceStores` bundle with every worker
(`crates/nostreamd/src/main.rs`, `crates/nostream-services/src/unavailable.rs::stores`).
The relay keeps its own narrower `Stores`; widening it would push invoice and outbox doubles
into the relay crate for no relay behaviour.

**What would overturn it:** #864 landing a second backend. Per-worker re-resolution then
becomes a real question again, and it is a matter of calling the resolver per worker, not of
changing the seam.

### D6 — The Tor port spec targets loopback

The capture sends `Port=<hidden>,<hostname>:<hidden>` (`src/app/app.ts:204-205`), which
resolves the container's hostname and repeats the hidden port as the target. This rewrite
sends `Port=<hidden>,127.0.0.1:<relay port>` (`TorConfig::port_spec`), which is what Tor
actually needs to forward the onion port to the relay. It is wire-visible and asserted
byte-for-byte in `crates/nostream-services/tests/tor_client.rs`.

**What would overturn it:** an operator whose Tor daemon runs on another host. That already
needs `TOR_HOST` on the control side, and the port spec would then need that host too.

### D7 — `createInvoice` and `confirmInvoice` are ordered writes, not one transaction

The capture spans the user upsert, the invoice upsert and the outbox enqueue in one
transaction. The repository traits here take no transaction parameter
(`crates/nostream-storage/src/repositories.rs:414-443`) and no backend is wired in this job,
so the order and the first-error reporting are preserved and the three writes are
sequential. A failure leaves at most an orphan user row or an invoice the next maintenance
walk resolves. `PostgresTransaction` already implements the three traits
(`crates/nostream-storage/src/postgres/repository.rs:397,465,526`), which is the seam a
follow-up job uses.

**What would overturn it:** a requirement for atomicity now. That is a storage-seam job: the
traits gain a transaction parameter (or a unit-of-work parameter), not a change in the
payments service alone. This is the one place this job knowingly weakens a capture
guarantee, and the spec marks it for the approver.
