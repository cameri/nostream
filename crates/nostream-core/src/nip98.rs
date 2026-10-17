//! NIP-98: HTTP authentication. Mirrors `src/utils/nip98.ts` and `src/utils/nip98-replay.ts`.

use crate::error::CoreError;
use crate::event::Pubkey;

/// The claims of a NIP-98 `Authorization: Nostr <base64 event>` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpAuth {
    pub pubkey: Pubkey,
    pub url: String,
    pub method: String,
    pub created_at: i64,
    pub payload_hash: Option<String>,
}

/// Verifies a NIP-98 header against the request it accompanies.
///
/// Phase 1 stub — job 005; will verify the event, the URL/method tags and the replay window;
/// see `src/utils/nip98.ts`.
pub fn verify(_header: &str, _url: &str, _method: &str, _body: &[u8], _max_skew_seconds: i64) -> Result<HttpAuth, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::nip98::verify",
    })
}
