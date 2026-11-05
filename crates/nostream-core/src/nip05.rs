//! NIP-05: DNS-based identifiers. Mirrors `src/utils/nip05.ts` and `src/@types/nip05.ts`.
//!
//! The pure half is implemented — identifier parsing, extraction from a kind-0 metadata
//! event, and the domain allow/deny rule. [`verify`] performs the fetch through
//! [`Nip05Fetch`], which this crate owns and `nostream-services` implements; the background
//! refresh that calls it is `nostream-services`' maintenance pass.

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

/// The verification timeout (`VERIFICATION_TIMEOUT_MS`, `src/utils/nip05.ts:11`).
pub const VERIFICATION_TIMEOUT_MS: u64 = 10_000;

/// The response-size cap (`MAX_RESPONSE_BYTES`, `src/utils/nip05.ts:13`).
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024;

/// The redirect budget (`MAX_REDIRECTS`, `src/utils/nip05.ts:16`).
pub const MAX_REDIRECTS: usize = 1;

/// One fetched document: the status and the body bytes, capped by the transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchOutcome {
    pub status: u16,
    pub body: Vec<u8>,
}

/// The transport seam `verify` calls.
///
/// Core owns it because core must not depend on `nostream-services`: `nostream-services`
/// implements it once with the HTTP client its processors use (`src/utils/nip05.ts`'s
/// `axios.get`).
pub trait Nip05Fetch: Send + Sync {
    /// GETs `url`, following at most `max_redirects` redirects, within `timeout_ms`, and
    /// failing when the body exceeds `max_bytes`.
    fn get<'a>(
        &'a self,
        url: &'a str,
        timeout_ms: u64,
        max_bytes: usize,
        max_redirects: usize,
    ) -> std::pin::Pin<
        Box<dyn Future<Output = Result<FetchOutcome, CoreError>> + Send + 'a>,
    >;
}

/// What one verification attempt settled (`Nip05VerificationOutcome`,
/// `src/utils/nip05.ts:31-36`).
///
/// `verified`, `mismatch` and `invalid` are definitive; `error` is transient, so a caller
/// keeps a previous verification and only bumps its failure count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerificationOutcome {
    Verified,
    Mismatch,
    Invalid { reason: String },
    Error { reason: String },
}

/// Fetches and checks `https://<domain>/.well-known/nostr.json?name=<local>`.
///
/// A malformed identifier, a non-200 status, an oversized or unparseable document and a
/// transport failure are reported as outcomes rather than errors, exactly as the capture's
/// `verifyNip05Identifier` does.
pub async fn verify(
    fetch: &dyn Nip05Fetch,
    identifier: &str,
    expected_pubkey: &str,
) -> VerificationOutcome {
    let Some(parsed) = parse_identifier(identifier) else {
        return VerificationOutcome::Invalid {
            reason: "unparseable NIP-05 identifier".to_owned(),
        };
    };

    let url = format!(
        "https://{}/.well-known/nostr.json?name={}",
        parsed.domain,
        encode_component(&parsed.local_part)
    );

    let outcome = match fetch
        .get(
            &url,
            VERIFICATION_TIMEOUT_MS,
            MAX_RESPONSE_BYTES,
            MAX_REDIRECTS,
        )
        .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            return VerificationOutcome::Error {
                reason: error.to_string(),
            };
        }
    };

    if outcome.status != 200 {
        return VerificationOutcome::Error {
            reason: format!("HTTP status {}", outcome.status),
        };
    }

    if outcome.body.len() > MAX_RESPONSE_BYTES {
        return VerificationOutcome::Error {
            reason: format!(
                "response body exceeds {MAX_RESPONSE_BYTES} bytes: {}",
                outcome.body.len()
            ),
        };
    }

    let document: serde_json::Value = match serde_json::from_slice(&outcome.body) {
        Ok(document) => document,
        Err(error) => {
            return VerificationOutcome::Error {
                reason: error.to_string(),
            };
        }
    };

    let Some(names) = document.get("names").and_then(serde_json::Value::as_object) else {
        return VerificationOutcome::Invalid {
            reason: "malformed response: names is missing or not an object".to_owned(),
        };
    };

    for (name, pubkey) in names {
        if !is_pubkey(pubkey.as_str().unwrap_or_default()) {
            return VerificationOutcome::Invalid {
                reason: format!("malformed response: names.{name} is not a 64-character hex pubkey"),
            };
        }
    }

    match names.get(&parsed.local_part).and_then(serde_json::Value::as_str) {
        Some(registered) if registered.eq_ignore_ascii_case(expected_pubkey) => {
            VerificationOutcome::Verified
        }
        _ => VerificationOutcome::Mismatch,
    }
}

/// `encodeURIComponent` for the local part: everything but the unreserved set is escaped.
fn encode_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());

    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }

    encoded
}

/// The capture's `pubkeySchema`: exactly 64 lowercase hex characters.
fn is_pubkey(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
