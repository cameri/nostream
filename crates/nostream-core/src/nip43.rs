//! NIP-43: relay membership and invite codes. Mirrors `src/utils/nip43.ts` and
//! `src/utils/nip43-invites.ts`.

use crate::error::CoreError;
use crate::event::{Event, Kind, Pubkey};

/// An invite code with its mint parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteCode {
    pub code: String,
    pub max_uses: u32,
    pub expires_at: Option<i64>,
    pub claimed_by: Vec<Pubkey>,
}

/// Mints a kind-28935 invite code for an authenticated requester.
///
/// Phase 1 stub — job 005; will mint and persist an invite code; see `src/utils/nip43-invites.ts`.
pub fn mint_invite(
    _requester: &Pubkey,
    _max_uses: u32,
    _expiry_seconds: u64,
) -> Result<Event, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::nip43::mint_invite",
    })
}

/// Whether a kind is the membership join request (`src/utils/nip43.ts`).
pub fn is_join_request(kind: Kind) -> bool {
    kind == Kind(28_934)
}
