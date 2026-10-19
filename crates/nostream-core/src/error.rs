//! The crate's error type. Every library crate in this workspace names its own.

use thiserror::Error;

/// Errors raised by `nostream-core`.
#[derive(Debug, Error)]
pub enum CoreError {
    /// A Phase 1 stub. The module names the call that is not implemented yet.
    #[error("not implemented in Phase 1 (job 005): {module}")]
    NotImplemented { module: &'static str },

    /// The event violates the base schema (id/sig length, kind range, tag shape).
    #[error("invalid event: {0}")]
    InvalidEvent(String),

    /// The event's signature does not verify over its id.
    #[error("invalid signature")]
    InvalidSignature,

    /// `created_at` is farther ahead of the reference time than the relay allows
    /// (`src/handlers/event-message-handler.ts:204-212`).
    #[error("rejected: created_at is more than {delta} seconds in the future")]
    CreatedAtInFuture { delta: i64 },

    /// `created_at` is farther behind the reference time than the relay allows
    /// (`src/handlers/event-message-handler.ts:214-218`).
    #[error("rejected: created_at is more than {delta} seconds in the past")]
    CreatedAtInPast { delta: i64 },

    /// A NIP-44 payload failed its version, size, padding or MAC check. The message is
    /// the capture's, verbatim (`src/utils/nip44.ts:116-150`).
    #[error("{0}")]
    InvalidNip44(String),

    /// NIP-77 storage could not be built from the items offered (negative or
    /// out-of-range `created_at`, or a set the storage refused).
    #[error("invalid negentropy storage: {0}")]
    InvalidNegentropyStorage(String),

    /// A wire frame could not be decoded into a known message.
    #[error("invalid message: {0}")]
    InvalidMessage(String),
}
