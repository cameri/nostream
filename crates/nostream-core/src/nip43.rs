//! NIP-43: relay membership and invite codes. Mirrors `src/utils/nip43.ts` and
//! `src/utils/nip43-invites.ts`.
//!
//! The pure half is implemented: the invite code's entropy, the limits the settings
//! resolve, and the relay-signed kind-28935 event that answers a REQ. Persisting the code is
//! the REQ handler's call into `InviteCodeRepository`; [`InviteCode`] is the row shape.

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

/// The default number of uses one minted code carries (`DEFAULT_INVITE_MAX_USES`,
/// `src/utils/nip43-invites.ts:10`).
pub const DEFAULT_INVITE_MAX_USES: u32 = 1;

/// The default lifetime of one minted code (`DEFAULT_INVITE_CODE_EXPIRY_SECONDS`,
/// `src/utils/nip43-invites.ts:11`).
pub const DEFAULT_INVITE_CODE_EXPIRY_SECONDS: u64 = 600;

/// The limits one minted code carries (`resolveInviteCodeLimits`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InviteCodeLimits {
    pub remaining_uses: u32,
    /// Unix seconds, `None` when the code never expires.
    pub expires_at: Option<i64>,
}

/// Resolves the limits from `nip43.defaultMaxUses` and `nip43.inviteCodeExpirySeconds`
/// (`resolveInviteCodeLimits`, `src/utils/nip43-invites.ts:47-66`). A non-positive or
/// non-finite expiry means no expiry.
pub fn resolve_invite_limits(
    default_max_uses: Option<u32>,
    expiry_seconds: Option<u64>,
    now_secs: i64,
) -> Result<InviteCodeLimits, CoreError> {
    let remaining_uses = default_max_uses.unwrap_or(DEFAULT_INVITE_MAX_USES);

    if remaining_uses < 1 {
        return Err(CoreError::InvalidMessage(
            "remainingUses must be a positive integer".to_owned(),
        ));
    }

    let expiry_seconds = expiry_seconds.unwrap_or(DEFAULT_INVITE_CODE_EXPIRY_SECONDS);
    let expires_at = (expiry_seconds > 0)
        .then(|| i64::try_from(expiry_seconds).unwrap_or(i64::MAX))
        .map(|seconds| now_secs.saturating_add(seconds));

    Ok(InviteCodeLimits {
        remaining_uses,
        expires_at,
    })
}

/// A fresh invite code: 16 random bytes, hex (`generateInviteCode`,
/// `src/utils/nip43-invites.ts:14`).
pub fn generate_invite_code() -> Result<String, CoreError> {
    invite_code_from(&crate::random::SystemRandom)
}

/// The same code over an injected source, for the differential fixture.
pub fn invite_code_from(random: &dyn crate::random::RandomSource) -> Result<String, CoreError> {
    Ok(hex::encode(random.bytes(16)?))
}

/// Builds the relay-signed kind-28935 event that answers an invite request
/// (`buildInviteCodeEvent`, `src/utils/nip43-invites.ts:96-121`).
///
/// The `claim` tag is a bearer secret: the caller sends this event only to the socket that
/// asked for it, and never persists or broadcasts it.
pub fn build_invite_code_event(
    secret_key: &[u8; 32],
    code: &str,
    limits: &InviteCodeLimits,
    created_at: i64,
) -> Result<Event, CoreError> {
    let mut tags = vec![
        vec!["claim".to_owned(), code.to_owned()],
        vec!["-".to_owned()],
    ];

    if let Some(expires_at) = limits.expires_at {
        tags.push(vec!["expiration".to_owned(), expires_at.to_string()]);
    }

    let mut event = Event {
        id: crate::event::EventId::from_byte_array([0; 32]),
        pubkey: crate::event::Pubkey::from_byte_array([0; 32]),
        created_at,
        kind: Kind(28_935),
        tags,
        content: String::new(),
        sig: crate::event::Signature::from_byte_array([0; 64]),
    };

    crate::crypto::sign_event(secret_key, &mut event)?;

    Ok(event)
}

/// Whether a kind is the membership join request (`src/utils/nip43.ts`).
pub fn is_join_request(kind: Kind) -> bool {
    kind == Kind(28_934)
}
