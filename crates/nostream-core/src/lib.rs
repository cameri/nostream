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
//!   `src/utils/negentropy.ts`, `src/utils/nip03.ts`,
//!   `src/utils/nip05.ts`, `src/utils/nip25.ts`, `src/utils/nip42.ts`,
//!   `src/utils/nip42-session.ts`, `src/utils/nip43.ts`, `src/utils/nip43-invites.ts`,
//!   `src/utils/nip44.ts`, `src/utils/nip56.ts`, `src/utils/nip65.ts`,
//!   `src/utils/nip66-events.ts`, `src/utils/nip66-nip11-tags.ts`,
//!   `src/utils/nip66-schedule.ts`, `src/utils/nip98.ts`,
//!   `src/utils/nip98-replay.ts`, `src/utils/proof-of-work.ts`,
//!   `src/utils/report-scoring.ts`, `src/utils/secret.ts`, `src/utils/shutdown-state.ts`,
//!   `src/utils/stream.ts`, `src/utils/template-cache.ts`, `src/utils/transform.ts`,
//!   `src/utils/validation.ts`, `src/utils/wot-pow-policy.ts`
//!
//! Implemented here, against those files: the 32-byte `EventId`/`Pubkey` and 64-byte
//! `Signature` with the schema's hex rules in the type, the canonical serialization and
//! SHA-256 event id, BIP-340 Schnorr verification and signing, the NIP-01 filter matcher
//! and the zod filter schema's rules with `count_filter_values`/`is_generic_tag_query`,
//! subscription normalisation, NIP-13 difficulty, NIP-40 expiration, NIP-44 v2, the strict
//! event schema ([`validation::validate_event`] with the kind 7/17/10002 and geohash
//! refinements), the wire codec ([`messages::decode`] and the one encoder
//! `RelayMessage::to_text`), NIP-42 ([`nip42::authenticate`], [`nip42::generate_challenge`]
//! and [`nip42::Nip42Session`]), the NIP-43 invite code and its event, the NIP-05 identifier
//! helpers, the adaptive-difficulty signal and its WoT policy, [`clock::Clock`] and
//! [`random::RandomSource`], and the NIP-77 reconciliation engine (over the `negentropy`
//! crate; see `negentropy.rs` for the seam and its divergences).
//!
//! What is still a stub is marked as such on the item and returns
//! `CoreError::NotImplemented`: the NIP frames' own codec layer, NIP-05 verification
//! (`nip05::verify`), and the NIP-77 session state machine.
//!
//! Phase 2+ areas this crate deliberately does not own: the NIP-77 wire state machine and
//! its `NEG-OPEN`/`NEG-MSG`/`NEG-CLOSE` frame encoder belong to `nostream-relay` once a real
//! transport exists — the file those frames are described in, `src/utils/nip77.ts`, does
//! not exist at the capture (it appears at the porting oracle `041fe34e`), and neither does
//! `src/utils/negentropy-sessions.ts`; the stored-query path (Postgres full-text search and
//! `EXISTS`-per-tag SQL) is `nostream-storage`'s. The event acceptance gate's *policy* is
//! `nostream-relay`'s — the kind-specific tag rules, which `created_at` deltas apply, and
//! where the check is called; the pure predicate those rules call,
//! [`time::check_created_at`], is this crate's, and so is the `created_at` window arithmetic
//! it carries.

pub mod adaptive_pow;
pub mod clock;
pub mod constants;
pub mod crypto;
pub mod error;
pub mod event;
pub mod event_store;
pub mod expiration;
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
pub mod random;
pub mod replaceable;
pub mod report_scoring;
pub mod secret;
pub mod time;
pub mod validation;

pub use clock::{Clock, SystemClock, TestClock};
pub use error::CoreError;
pub use event::{
    CanonicalEvent, Event, EventId, Kind, KindSelector, Pubkey, SettingsPubkey, Signature, Tag,
};
pub use event_store::EventStoreBackend;
pub use filter::{Filter, FilterIssue};
pub use lifecycle::ShutdownState;
pub use messages::{ClientMessage, RelayMessage};
pub use secret::Secret;
