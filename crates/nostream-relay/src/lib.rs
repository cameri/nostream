//! `nostream-relay` owns the Nostr wire: the transport and per-connection state machine, the
//! positional frame codec's use, the five message handlers, the event strategies and their
//! ordered registry, the NIP-42 session and read guards, and the rate limiters.
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
//! - `src/utils/{sliding-window-rate-limiter,ewma-rate-limiter,hidden-content-cache,
//!   relay-broadcast-deduplicator,relay-broadcast-message,relay-broadcast-state}.ts`
//! - `src/@types/{message-handlers,subscription,clients}.ts`
//! - `src/factories/{event-strategy-factory,message-handler-factory,
//!   websocket-adapter-factory,rate-limiter-factory}.ts`
//!
//! **Implemented here:** the transport (`transport.rs`: `tokio-tungstenite` 0.30, the
//! settings-derived message limit, the close codes, the drain timeout), the per-socket state
//! machine (`connection.rs`, `relay.rs`: subscriptions, liveness, drain, live dispatch), the
//! five handlers, the strategy trait with its ordered registry and all fifteen strategies,
//! the web-of-trust seam those strategies reach for (`wot.rs`), the NIP-42 session and read
//! guards' wiring, the two rate limiters over an in-process store, and the NIP-56
//! hidden-content mirror. The positional codec, `validation::validate_event`
//! and `nip42::{authenticate, generate_challenge}` are `nostream-core`'s.
//!
//! **Still stubbed:** `NegentropySession`/`open_negentropy_session` (a NIP-77 job cut against
//! `041fe34e`, where the `neg-*` handlers first exist), and the cross-worker broadcast
//! `publish`/`deduplicate` (unassigned:
//! `src/relay-broadcast/redis-relay-broadcast-fanout.ts` is named by no bullet of issue #865,
//! which is why `broadcast.rs` still carries phase-1 stub labels naming job 005, and the job
//! may be re-cut). `broadcast.rs` therefore carries no behaviour; the in-process fan-out this
//! crate needs is the relay's own broadcast channel.
//!
//! Phase 2+ areas this crate does not own: the HTTP surface and NIP-11 document
//! (`nostream-admin`), and the probe family and NIP-66 monitor (`nostream-services`).
//!
//! The event acceptance gate this crate owns is the *policy*: the kind-specific tag rules,
//! which `created_at` deltas the settings supply, and where the check runs. The pure
//! predicate it calls — `nostream_core::time::check_created_at` — is core's, along with the
//! rest of the reference-time arithmetic; do not re-implement it here.

pub mod broadcast;
pub mod connection;
pub mod error;
pub mod handlers;
pub mod hidden_content;
pub mod limits;
pub mod relay;
pub mod relay_key;
pub mod sink;
pub mod strategies;
pub mod testing;
pub mod transport;
pub mod unavailable;
pub mod wot;

pub use error::RelayError;
pub use relay::{Relay, RelayConfig};
