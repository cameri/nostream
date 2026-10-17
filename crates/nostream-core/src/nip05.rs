//! NIP-05: DNS-based identifiers. Mirrors `src/utils/nip05.ts` and `src/@types/nip05.ts`.

use crate::error::CoreError;
use crate::event::Pubkey;

/// A verification record: the identifier, its pubkey and the verification state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nip05Verification {
    pub pubkey: Pubkey,
    pub identifier: String,
    pub verified_at: Option<i64>,
    pub failed_checks: u32,
}

/// Fetches and verifies `https://<domain>/.well-known/nostr.json?name=<local>`.
///
/// Phase 1 stub — job 005; will fetch and check the identifier's pubkey binding; see `src/utils/nip05.ts`.
pub fn verify(_identifier: &str) -> Result<Nip05Verification, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::nip05::verify",
    })
}
