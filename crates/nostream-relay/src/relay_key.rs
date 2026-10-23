//! The relay's signing key. Mirrors `getRelayPrivateKey`/`deriveFromSecret`
//! (`src/utils/event.ts:142-154`, `src/utils/secret.ts`).
//!
//! `RELAY_PRIVATE_KEY`, when set, is the secret key; otherwise the key is
//! `HMAC-SHA256(SECRET, relay_url)` — the capture's `deriveFromSecret(relay_url)`. With
//! neither set the relay has no key, and every caller that needs one reports the capture's
//! outcome: an EVENT is answered `["OK",<id>,false,"error: unable to process event"]`
//! (ADR 0004).
//!
//! Resolution is memoised on the source: the capture caches in a module-level
//! `privateKeyCache`, which is one process, and a source is one process's settings.

use std::sync::{Arc, Mutex};

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use nostream_core::Pubkey;
use nostream_core::crypto::public_key;

use crate::error::RelayError;

type HmacSha256 = Hmac<Sha256>;

/// The environment variables the relay key reads. `RELAY_PRIVATE_KEY` wins over `SECRET`.
#[derive(Debug, Clone, Default)]
pub struct RelayKeySource {
    relay_private_key: Option<String>,
    secret: Option<String>,
    resolved: Arc<Mutex<Option<(String, RelayKeys)>>>,
}

impl RelayKeySource {
    /// Reads `RELAY_PRIVATE_KEY` and `SECRET` once.
    pub fn from_env() -> Self {
        Self::from_values(
            std::env::var("RELAY_PRIVATE_KEY").ok(),
            std::env::var("SECRET").ok(),
        )
    }

    /// A source with the two values supplied, for tests and for the daemon's composition.
    pub fn from_values(relay_private_key: Option<String>, secret: Option<String>) -> Self {
        Self {
            relay_private_key: relay_private_key.filter(|value| !value.is_empty()),
            secret: secret.filter(|value| !value.is_empty()),
            resolved: Arc::new(Mutex::new(None)),
        }
    }

    /// The relay's key pair, or [`RelayError::Configuration`] when neither source is set.
    ///
    /// The pair is memoised with the URL it was derived from: `SECRET` seeds the key from the
    /// relay's URL, so a second call with another URL must derive again rather than inherit
    /// the first one's key.
    pub fn resolve(&self, relay_url: &str) -> Result<RelayKeys, RelayError> {
        {
            let resolved = self
                .resolved
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            if let Some((url, keys)) = resolved.as_ref()
                && url == relay_url
            {
                return Ok(*keys);
            }
        }

        let key = match (&self.relay_private_key, &self.secret) {
            (Some(private_key), _) => parse_secret_key(private_key)?,
            (None, Some(secret)) => derive_from_secret(secret, relay_url)?,
            (None, None) => {
                return Err(RelayError::Configuration(
                    "SECRET environment variable not set".to_owned(),
                ));
            }
        };

        let keys = RelayKeys {
            secret_key: key,
            public_key: public_key(&key)
                .map_err(|error| RelayError::Configuration(error.to_string()))?,
        };

        *self
            .resolved
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((relay_url.to_owned(), keys));

        Ok(keys)
    }

    /// The relay's public key, or `None` when no key source is configured. This is the
    /// capture's `tryGetRelayNip43Pubkey` shape: callers that only need the identity (the
    /// admission and NIP-05 bypasses, the rate-limit bypass) do not fail without a key.
    pub fn try_public_key(&self, relay_url: &str) -> Option<Pubkey> {
        self.resolve(relay_url).ok().map(|keys| keys.public_key)
    }
}

/// The relay's signing key pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RelayKeys {
    pub secret_key: [u8; 32],
    pub public_key: Pubkey,
}

fn parse_secret_key(value: &str) -> Result<[u8; 32], RelayError> {
    let bytes = hex::decode(value).map_err(|error| {
        RelayError::Configuration(format!("RELAY_PRIVATE_KEY is not hexadecimal: {error}"))
    })?;

    bytes.try_into().map_err(|bytes: Vec<u8>| {
        RelayError::Configuration(format!(
            "RELAY_PRIVATE_KEY must be 32 bytes, got {}",
            bytes.len()
        ))
    })
}

/// `HMAC-SHA256(SECRET, purpose)` (`hmacSha256`, `src/utils/secret.ts:10-13`).
fn derive_from_secret(secret: &str, purpose: &str) -> Result<[u8; 32], RelayError> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|error| RelayError::Configuration(format!("SECRET: {error}")))?;

    mac.update(purpose.as_bytes());

    Ok(mac.finalize().into_bytes().into())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn a_secret_derived_key_is_memoised_per_relay_url() {
        // `SECRET` seeds the key from the relay's URL, so the memo has to remember which URL
        // produced the pair it holds.
        let source = RelayKeySource::from_values(None, Some("operator-secret".to_owned()));

        let first = source.resolve("wss://one.example").expect("a key");
        let again = source
            .resolve("wss://one.example")
            .expect("the memoised key");
        let other = source.resolve("wss://two.example").expect("a key");

        assert_eq!(first, again);
        assert_ne!(
            first.public_key, other.public_key,
            "a second URL derives a second key"
        );
    }

    #[test]
    fn an_explicit_private_key_does_not_depend_on_the_url() {
        // `01` repeated is a valid secp256k1 scalar; all zeros is not.
        let source =
            RelayKeySource::from_values(Some("01".repeat(32)), Some("operator-secret".to_owned()));

        assert_eq!(
            source.resolve("wss://one.example").expect("a key"),
            source.resolve("wss://two.example").expect("a key")
        );
    }
}
