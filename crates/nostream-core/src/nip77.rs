//! NIP-77: negentropy sync. Mirrors `src/utils/nip77.ts`.
//!
//! Phase 1 has the types only. The `neg-open`/`neg-msg`/`neg-close` wire handlers exist at
//! the porting oracle (`041fe34e`) but not at this branch's capture commit, so no handler
//! module is named here.

use crate::error::CoreError;

/// The reconciliation protocol version and id set size advertised by a peer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NegOpenMessage {
    pub subscription_id: String,
    pub initial_message: Vec<u8>,
}

/// Encodes a `NEG-OPEN` message for a subscription.
///
/// Phase 1 stub — job 005; will encode the NIP-77 NEG-OPEN frame; see `src/utils/nip77.ts`.
pub fn encode_neg_open(_message: &NegOpenMessage) -> Result<String, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::nip77::encode_neg_open",
    })
}
