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
//! The MCP server named in the issue is Phase 5 and has no TS counterpart at the capture; it
//! has no module here either.

pub mod acceptor;
pub mod error;
pub mod settings_gate;
pub mod telemetry;
pub mod workers;

pub use acceptor::Acceptor;
pub use error::DaemonError;
