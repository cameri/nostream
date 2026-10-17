//! NIP-77 negentropy set reconciliation. Mirrors `src/utils/negentropy.ts` (the session
//! bookkeeping named `negentropy-sessions.ts` lives only at the oracle `041fe34e`, not at
//! this branch's capture; the session seam here is this port's own shape).

use crate::error::CoreError;

/// One item in a negentropy exchange: a 32-byte id and its timestamp.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NegentropyItem {
    pub id: [u8; 32],
    pub timestamp: u64,
}

/// Builds the initial reconciliation message from the local item set.
///
/// Phase 1 stub — job 005; will encode the initial negentropy message; see `src/utils/negentropy.ts`.
pub fn reconcile(_local: &[NegentropyItem], _remote_message: &[u8]) -> Result<Vec<u8>, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::negentropy::reconcile",
    })
}
