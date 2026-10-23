//! NIP-05: DNS-based identifiers. Mirrors `src/utils/nip05.ts` and `src/@types/nip05.ts`.
//!
//! The pure half is implemented — identifier parsing, extraction from a kind-0 metadata
//! event, and the domain allow/deny rule. [`verify`] is the network fetch and stays a
//! labelled stub: no handler in this job may block on it, and the background refresh that
//! would call it is `nostream-services`' work.

use crate::error::CoreError;
use crate::event::{Event, Kind, Pubkey};

/// The default verification lifetime, 7 days (`DEFAULT_NIP05_VERIFY_EXPIRATION_MS`,
/// `src/utils/nip05.ts:21`).
pub const DEFAULT_NIP05_VERIFY_EXPIRATION_MS: i64 = 604_800_000;

/// The domain grammar `parseNip05Identifier` enforces (`DOMAIN_REGEX`,
/// `src/utils/nip05.ts:17`): labels of alphanumerics and hyphens, then a TLD of two or more
/// letters.
fn is_valid_domain(domain: &str) -> bool {
    let labels: Vec<&str> = domain.split('.').collect();

    if labels.len() < 2 {
        return false;
    }

    let Some(tld) = labels.last() else {
        return false;
    };

    if tld.len() < 2 || !tld.chars().all(|character| character.is_ascii_alphabetic()) {
        return false;
    }

    labels[..labels.len() - 1].iter().all(|label| {
        !label.is_empty()
            && label
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

/// A parsed `local@domain` identifier (`parseNip05Identifier`, `src/utils/nip05.ts:56-76`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nip05Identifier {
    pub local_part: String,
    pub domain: String,
}

/// Parses `local@domain`; the local part is lowercased, and the domain must match the
/// capture's grammar.
pub fn parse_identifier(nip05: &str) -> Option<Nip05Identifier> {
    let at = nip05.rfind('@')?;

    if at == 0 || at == nip05.len() - 1 {
        return None;
    }

    let local_part = &nip05[..at];
    let domain = &nip05[at + 1..];

    if local_part.is_empty() || domain.is_empty() || !is_valid_domain(domain) {
        return None;
    }

    Some(Nip05Identifier {
        local_part: local_part.to_lowercase(),
        domain: domain.to_lowercase(),
    })
}

/// The `nip05` field of a kind-0 metadata event's content
/// (`extractNip05FromEvent`, `src/utils/nip05.ts:79-96`).
pub fn extract_from_event(event: &Event) -> Option<String> {
    if event.kind != Kind::METADATA {
        return None;
    }

    let metadata: serde_json::Value = serde_json::from_str(&event.content).ok()?;

    metadata
        .get("nip05")
        .and_then(serde_json::Value::as_str)
        .filter(|nip05| !nip05.is_empty())
        .map(str::to_owned)
}

/// The domain allow/deny rule (`isDomainAllowed`, `src/utils/nip05.ts:204-219`): the
/// blacklist wins, then a non-empty whitelist must contain the domain, case-insensitively.
pub fn is_domain_allowed(
    domain: &str,
    whitelist: Option<&[String]>,
    blacklist: Option<&[String]>,
) -> bool {
    let lower_domain = domain.to_lowercase();

    if let Some(blacklist) = blacklist.filter(|list| !list.is_empty())
        && blacklist
            .iter()
            .any(|entry| entry.to_lowercase() == lower_domain)
    {
        return false;
    }

    if let Some(whitelist) = whitelist.filter(|list| !list.is_empty())
        && !whitelist
            .iter()
            .any(|entry| entry.to_lowercase() == lower_domain)
    {
        return false;
    }

    true
}

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
