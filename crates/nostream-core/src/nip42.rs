//! NIP-42: authentication of clients to relays. Mirrors `src/utils/nip42.ts` and
//! `src/utils/nip42-session.ts`.

use crate::error::CoreError;
use crate::event::{Event, Pubkey};

/// The relay's per-connection authentication state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthState {
    pub challenge: Option<String>,
    pub authenticated_pubkey: Option<Pubkey>,
    pub expires_at: Option<i64>,
}

/// Checks that a kind-22242 event answers this challenge and is signed by its author.
///
/// Phase 1 stub — job 005; will verify the challenge tag, relay tag and signature; see `src/utils/nip42.ts`.
pub fn authenticate(_event: &Event, _challenge: &str, _relay_url: &str) -> Result<Pubkey, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::nip42::authenticate",
    })
}

/// Generates a fresh challenge for a connection.
///
/// Phase 1 stub — job 005; will mint a per-connection challenge; see `src/utils/nip42.ts`.
pub fn generate_challenge() -> Result<String, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::nip42::generate_challenge",
    })
}
