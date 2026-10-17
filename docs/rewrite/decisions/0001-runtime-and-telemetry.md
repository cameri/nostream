# ADR 0001: Runtime, acceptor shape and telemetry (Phase 1)

- **Status:** accepted (job 005, Phase 1)
- **Deciders:** the rewrite team, on the evidence available at job 005
- **Date:** 2026-10-17

## Context

The Rust rewrite replaces a Node.js relay whose process model is **cluster-based**:
`src/index.ts` boots `App` in the primary; `src/app/app.ts:102-125` forks
`WORKER_COUNT`-else-`workers.count`-else-`cpus().length` client workers
(`WORKER_TYPE=worker`), and `app.ts:127-155` forks the specialist workers — one
maintenance, one static-mirroring per configured mirror, one relay-monitor when
`nip66.enabled`, and `dvm.workers.length` DVM orchestrators. **Only `AppWorker` listens**:
`src/app/worker.ts:32` computes the port (`PORT` || `RELAY_PORT` || 8008) and `:33` calls
`adapter.listen(port)`, so the capture runs one listener per client worker (the
specialists never touch the adapter) — the OS queues the connections and each client
worker accepts, with cluster IPC re-emitting messages into its adapter
(`worker.ts:36-37`). The primary resolves the event-store backend once
(`app.ts:92-95`) and stamps `EVENT_STORE_BACKEND` into every fork's env. Drain runs on
SIGINT/SIGTERM through `src/utils/shutdown-state.ts`. The telemetry section of the
original spec named a `tracing-otlp` crate.

## Decisions

### D8 — Runtime and acceptor

1. **tokio multi-thread runtime** for the daemon (`nostreamd`), with `enable_all`.
2. **A single acceptor task** owns the listener. No `SO_REUSEPORT`, no per-core
   acceptor sharding in Phase 1. The capture's model — a cluster primary forking
   `cpus().length` client workers that each `listen()` the same port (only client
   workers listen; the specialist workers do not), plus the IPC hop that re-emits
   cluster messages into each worker's adapter — is what Phase 2 decides **against**
   or reproduces, on measurements, not upfront. (Round-1 correction: the capture is
   not cluster-less; the original wording here inverted it.) Phase 1 keeps the tokio
   equivalent of *one* worker: `Connection::accept` and the relay wire take the socket
   in Phase 2; until then sockets are accepted and dropped with a `debug!` line.
3. The listen port resolves as `--listen-port`, then `PORT`, then `RELAY_PORT`,
   then `8008` — the capture's rule, in order (`src/app/worker.ts:32`).
4. Drain: SIGINT/SIGTERM set `nostream_core::lifecycle::ShutdownState`
   (the port of `src/utils/shutdown-state.ts`); the acceptor's select loop stops
   accepting and the process exits 0.

### D9 — Telemetry

1. `tracing` + `tracing-subscriber` for spans/logs. **The crate named in the
   original spec, `tracing-otlp`, does not exist**; the deviation is to the real
   stack: `opentelemetry` + `opentelemetry-otlp` + `tracing-opentelemetry`.
2. Phase 1 ships the stdout subscriber; the OTLP exporter sits behind the
   `otlp` feature and is wired in Phase 5 (`initializeMetricsTelemetry` at the
   capture reads `OTEL_EXPORTER_OTLP_ENDPOINT`, `src/telemetry/metrics.ts:45`;
   with no endpoint the exporter is disabled, `:112` — the Rust side follows the
   same env convention, not a settings field, because the settings schema has no
   telemetry section).
3. **Metric-name contract:** existing dashboards read
   `nostream_<section>_<name>` snake-case names; the Phase-5 exporter keeps the
   names and unit suffixes the TS relay emits (`src/telemetry/metrics.ts`).

### D15 — One source of truth for shared shapes

The `Processor` enum (`keyof PaymentsProcessors`), `KindSelector` (untagged) and
`i64` for millisecond-precision timestamps/event ids live in `nostream-config` /
`nostream-core` and are re-exported, not redefined, by dependents.

## Consequences

- The daemon is boring to reason about: one listener, one drain flag, no
  runtime configuration surface beyond the capture's env vars.
- The `otlp` feature keeps tonic/prost out of the default build until Phase 5.
- If Phase 2 measurements show accept contention, the acceptor splits behind the
  same `ShutdownState` without a settings change.
