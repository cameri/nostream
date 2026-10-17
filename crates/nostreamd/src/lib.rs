//! `nostreamd` — the relay daemon: the runtime, the acceptor, telemetry and the signals.
//!
//! It owns these TypeScript paths from the capture commit
//! (`242a3001d77149e4d70151ec03060c4ef44a1547`):
//!
//! - `src/index.ts` and `src/main.ts` (bootstrap, signal handling, worker scheduling)
//! - `src/adapters/{web-socket-server-adapter,web-socket-adapter}.ts` (the listening half)
//! - `src/utils/scheduler.ts` (the recurring-worker loop)
//! - `src/tor/**` (the hidden service bootstrap)
//!
//! Runtime decision (ADR `0001-runtime-and-telemetry.md`): a single acceptor task, no
//! `SO_REUSEPORT` sharding until measurements ask for it. Phase 1 binds, accepts, drains on
//! SIGINT/SIGTERM through `nostream_core::lifecycle::ShutdownState` and drops sockets with a
//! debug line; the relay wire takes the socket in Phase 2.
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
