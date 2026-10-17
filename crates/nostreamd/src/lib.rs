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
//! `SO_REUSEPORT` sharding — the capture's cluster fan-out (primary + `cpus().length`
//! client workers all listening, IPC into each adapter) is the model Phase 2 decides
//! against. Phase 1 binds, accepts, drains on SIGINT/SIGTERM through
//! `nostream_core::lifecycle::ShutdownState` and drops sockets with a debug line; the relay
//! wire takes the socket in Phase 2.
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
