//! `nostreamd` — the relay daemon: the runtime, the acceptor, telemetry and the signals.
//!
//! It owns these TypeScript paths from the capture commit
//! (`242a3001d77149e4d70151ec03060c4ef44a1547`) — spec §3.2's daemon list:
//!
//! - `src/app/` (6 files: `app.ts` — the cluster primary that forks the workers — plus
//!   `worker.ts` and the four specialist workers)
//! - `src/index.ts` (the bootstrap) and `src/logger.ts`
//! - `src/adapters/web-server-adapter.ts` (the listening half; the two WebSocket adapters
//!   belong to `nostream-relay`)
//! - `src/routes/index.ts` (the top-level route mount)
//! - `src/telemetry/{metrics,event-metrics}.ts`
//! - `src/tor/client.ts` and `src/@types/tor.ts`
//! - the remaining `src/factories/` wiring: `app-factory`, `web-app-factory`,
//!   `worker-factory`, `logger-factory`, `maintenance-worker-factory`,
//!   `relay-monitor-worker-factory`, `static-mirroring.worker-factory`,
//!   `dvm-orchestrator-worker-factory`
//!
//! Runtime decision (ADR `0001-runtime-and-telemetry.md`): a single acceptor task, no
//! `SO_REUSEPORT` sharding — the capture's cluster fan-out (a primary forking
//! `cpus().length` client workers that each `listen()` the same port, IPC into each
//! worker's own adapter; the primary itself never listens) is the model Phase 2 decides
//! against. The daemon binds, hands the listener to `nostream_relay::Relay`, and drains on
//! SIGINT/SIGTERM through `nostream_core::lifecycle::ShutdownState`.
//!
//! **The worker model** (job 023): `serve` builds one `nostream_services::ServiceContext`
//! over the loaded settings, one resolved event-store bundle, the relay's own broadcast
//! sender (`Relay::hub`) and the HTTP/Tor seams, then hands it to
//! `workers::spawn_workers`. That function builds one
//! `nostream_services::scheduler::Supervisor` and registers one maintenance worker plus one
//! DVM orchestrator per `dvm.workers[i]`; the supervisor owns the capture's lifecycle
//! guarantees (restart after 10 s on an error, no restart on a clean return, drain to
//! `WS_DRAIN_TIMEOUT_MS` + 5 s and then abort) and returns `Ok(())` after a drain.
//! `workers::spawn_tor` is not a supervised worker: one bootstrap attempt logs
//! `Tor hidden service: <id>:<port>` or `Tor hidden service: disabled`, and never fails
//! startup. The task then holds the control connection until the drain, because Tor drops a
//! service the moment the connection that created it closes. The relay-monitor worker
//! belongs to #865 and is not registered here.
//!
//! The MCP server named in the issue is Phase 5 and has no TS counterpart at the capture; it
//! has no module here either.

pub mod acceptor;
pub mod error;
pub mod settings_gate;
pub mod telemetry;
pub mod workers;

pub use acceptor::Acceptor;
pub use error::DaemonError;
