//! `nostream-core` owns the relay's domain vocabulary: Nostr events, filters and kinds,
//! the client/relay wire messages, shared primitives, and the NIP type surfaces.
//!
//! It owns these TypeScript paths from the capture commit
//! (`242a3001d77149e4d70151ec03060c4ef44a1547`):
//!
//! - `src/constants/base.ts`
//! - `src/schemas/base-schema.ts`, `src/schemas/event-schema.ts`,
//!   `src/schemas/filter-schema.ts`, `src/schemas/message-schema.ts`
//! - `src/@types/base.ts`, `src/@types/event.ts`, `src/@types/messages.ts`,
//!   `src/@types/utils.ts`
//! - `src/utils/adaptive-pow.ts`, `src/utils/compression.ts`, `src/utils/event.ts`,
//!   `src/utils/filter.ts`, `src/utils/geohash.ts`, `src/utils/html.ts`,
//!   `src/utils/http.ts`, `src/utils/messages.ts`, `src/utils/misc.ts`,
//!   `src/utils/negentropy.ts`, `src/utils/negentropy-sessions.ts`, `src/utils/nip03.ts`,
//!   `src/utils/nip05.ts`, `src/utils/nip25.ts`, `src/utils/nip42.ts`,
//!   `src/utils/nip42-session.ts`, `src/utils/nip43.ts`, `src/utils/nip43-invites.ts`,
//!   `src/utils/nip44.ts`, `src/utils/nip56.ts`, `src/utils/nip65.ts`,
//!   `src/utils/nip66-events.ts`, `src/utils/nip66-nip11-tags.ts`,
//!   `src/utils/nip66-schedule.ts`, `src/utils/nip77.ts`, `src/utils/nip98.ts`,
//!   `src/utils/nip98-replay.ts`, `src/utils/proof-of-work.ts`,
//!   `src/utils/report-scoring.ts`, `src/utils/secret.ts`, `src/utils/shutdown-state.ts`,
//!   `src/utils/stream.ts`, `src/utils/template-cache.ts`, `src/utils/transform.ts`,
//!   `src/utils/validation.ts`, `src/utils/wot-pow-policy.ts`
//!
//! Phase 1 (job 005) carries the type surfaces and labelled stubs only. Every function that
//! needs real behaviour returns `CoreError::NotImplemented`; nothing here is a partial port.
//!
//! Phase 2+ areas this crate deliberately does not own: signature verification and event-id
//! hashing stay stubs until the crypto dependency choice (`secp256k1` vs `k256`, schnorr) is
//! recorded; the negentropy protocol engine and the NIP-77 wire state machine belong to
//! `nostream-relay` once a real transport exists.

pub mod adaptive_pow;
pub mod constants;
pub mod crypto;
pub mod error;
pub mod event;
pub mod event_store;
pub mod filter;
pub mod geohash;
pub mod lifecycle;
pub mod messages;
pub mod negentropy;
pub mod nip03;
pub mod nip05;
pub mod nip25;
pub mod nip42;
pub mod nip43;
pub mod nip44;
pub mod nip56;
pub mod nip65;
pub mod nip66;
pub mod nip77;
pub mod nip98;
pub mod pow;
pub mod report_scoring;
pub mod secret;
pub mod validation;

pub use error::CoreError;
pub use event::{Event, EventId, Kind, KindSelector, Pubkey};
pub use event_store::EventStoreBackend;
pub use filter::Filter;
pub use lifecycle::ShutdownState;
pub use secret::Secret;
pub use messages::{ClientMessage, RelayMessage};
