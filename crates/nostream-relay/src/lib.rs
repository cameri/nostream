//! `nostream-relay` owns the Nostr wire: the five message handlers, the event strategies, the
//! per-connection state, the rate limiters and the cross-worker broadcast fan-out.
//!
//! It owns these TypeScript paths from the capture commit
//! (`242a3001d77149e4d70151ec03060c4ef44a1547`):
//!
//! - `src/handlers/{auth,count,event,subscribe,unsubscribe}-message-handler.ts`
//! - `src/handlers/event-strategies/*-event-strategy.ts` (15 strategies)
//! - `src/adapters/web-socket-adapter.ts`, `src/adapters/web-socket-server-adapter.ts`
//! - `src/relay-broadcast/redis-relay-broadcast-fanout.ts`
//! - `src/controllers/admission/get-admission-check-controller.ts`,
//!   `src/routes/admissions/index.ts`
//! - `src/utils/{sliding-window-rate-limiter,ewma-rate-limiter,
//!   relay-broadcast-deduplicator,relay-broadcast-message,relay-broadcast-state}.ts`
//! - `src/@types/{message-handlers,subscription,clients}.ts`
//! - `src/factories/{event-strategy-factory,message-handler-factory,
//!   websocket-adapter-factory,rate-limiter-factory}.ts`
//!
//! Phase 1 carries the module map and labelled stubs only: no protocol behaviour, no WebSocket
//! dependency, no transport. The NIP-77 `neg-*` handlers exist at the porting oracle
//! (`041fe34e`) and are deliberately absent here. Phase 2+ areas this crate does not own: the
//! HTTP surface (nostream-admin) and the probe family (nostream-services).
//!
//! The event acceptance gate this crate will build owns the *policy*: the kind-specific tag
//! rules, which `created_at` deltas the settings supply, and where the check runs. The pure
//! predicate it calls — `nostream_core::time::check_created_at` — is core's, along with the
//! rest of the reference-time arithmetic; do not re-implement it here.

pub mod broadcast;
pub mod connection;
pub mod error;
pub mod handlers;
pub mod limits;
pub mod strategies;

pub use error::RelayError;
