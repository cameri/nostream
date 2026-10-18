//! NIP-44: versioned encrypted payloads. Mirrors `src/utils/nip44.ts`.

use crate::error::CoreError;

/// Decrypts a NIP-44 v2 payload with the sender's shared secret.
///
/// Phase 1 stub — job 005; will derive the conversation key and decrypt; see `src/utils/nip44.ts`.
pub fn decrypt(_payload: &str, _conversation_key: &[u8; 32]) -> Result<String, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::nip44::decrypt",
    })
}

/// Encrypts a payload for a peer.
///
/// Phase 1 stub — job 005; will pad and encrypt with the conversation key; see `src/utils/nip44.ts`.
pub fn encrypt(_plaintext: &str, _conversation_key: &[u8; 32]) -> Result<String, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::nip44::encrypt",
    })
}
