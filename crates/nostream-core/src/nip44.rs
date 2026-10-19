//! NIP-44: versioned encrypted payloads. Mirrors `src/utils/nip44.ts:1-180`.
//!
//! `base64(0x02 || nonce[32] || ciphertext || mac[32])`, where the ChaCha20 key, its 12-byte
//! nonce and the HMAC-SHA256 key are HKDF-expanded from the conversation key and the
//! per-message nonce, and the plaintext is padded with a two-byte big-endian length prefix.
//!
//! The nonce is an argument: the capture generates a random one inside `nip44Encrypt`, and
//! randomness is the relay's to supply (spec D13 for the clock, the same reasoning here).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chacha20::ChaCha20;
use chacha20::cipher::{KeyIvInit, StreamCipher};
use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use crate::crypto::shared_secret_x;
use crate::error::CoreError;
use crate::event::Pubkey;

type HmacSha256 = Hmac<Sha256>;

const MIN_PLAINTEXT_SIZE: usize = 1;
const MAX_PLAINTEXT_SIZE: usize = 65_535;

/// The NIP-44 version byte this module writes and accepts.
const VERSION: u8 = 2;

/// The smallest and largest base64 payload lengths the capture accepts
/// (`src/utils/nip44.ts:120-122`).
const MIN_PAYLOAD_LENGTH: usize = 132;
const MAX_PAYLOAD_LENGTH: usize = 87_472;

/// The smallest and largest decoded payload lengths the capture accepts
/// (`src/utils/nip44.ts:125-127`).
const MIN_DATA_LENGTH: usize = 99;
const MAX_DATA_LENGTH: usize = 65_603;

/// Derives the conversation key (`getConversationKey`, `src/utils/nip44.ts:36-42`):
/// HKDF-extract with the salt `nip44-v2` over the ECDH x-coordinate. The result is the same
/// whichever party computes it.
pub fn get_conversation_key(secret_key: &[u8; 32], peer: &Pubkey) -> Result<[u8; 32], CoreError> {
    let shared_x = shared_secret_x(secret_key, peer)?;
    let (pseudorandom_key, _) = Hkdf::<Sha256>::extract(Some(b"nip44-v2"), &shared_x);

    let mut conversation_key = [0u8; 32];
    conversation_key.copy_from_slice(&pseudorandom_key);

    Ok(conversation_key)
}

/// Encrypts `plaintext` into a NIP-44 v2 payload (`nip44Encrypt`,
/// `src/utils/nip44.ts:97-110`).
pub fn encrypt(
    plaintext: &str,
    conversation_key: &[u8; 32],
    nonce: &[u8; 32],
) -> Result<String, CoreError> {
    let keys = message_keys(conversation_key, nonce)?;
    let mut ciphertext = pad(plaintext)?;

    // ChaCha20 with counter 0 and the 12-byte nonce is what OpenSSL's 16-byte IV of four
    // zero bytes plus the nonce produces in the capture (`src/utils/nip44.ts:101-104`).
    let mut cipher = ChaCha20::new_from_slices(&keys.key, &keys.nonce)
        .map_err(|error| CoreError::InvalidNip44(format!("invalid key length: {error}")))?;
    cipher.apply_keystream(&mut ciphertext);

    let mut mac = HmacSha256::new_from_slice(&keys.mac)
        .map_err(|error| CoreError::InvalidNip44(format!("invalid key length: {error}")))?;
    mac.update(nonce);
    mac.update(&ciphertext);
    let tag = mac.finalize().into_bytes();

    let mut payload = Vec::with_capacity(1 + 32 + ciphertext.len() + 32);
    payload.push(VERSION);
    payload.extend_from_slice(nonce);
    payload.extend_from_slice(&ciphertext);
    payload.extend_from_slice(&tag);

    Ok(STANDARD.encode(payload))
}

/// Decrypts a NIP-44 v2 payload (`nip44Decrypt`, `src/utils/nip44.ts:116-150`).
pub fn decrypt(payload: &str, conversation_key: &[u8; 32]) -> Result<String, CoreError> {
    if payload.is_empty() || payload.starts_with('#') {
        return Err(invalid("unknown version"));
    }

    if payload.len() < MIN_PAYLOAD_LENGTH || payload.len() > MAX_PAYLOAD_LENGTH {
        return Err(invalid("invalid payload size"));
    }

    let data = STANDARD
        .decode(payload)
        .map_err(|_| invalid("invalid data size"))?;

    if data.len() < MIN_DATA_LENGTH || data.len() > MAX_DATA_LENGTH {
        return Err(invalid("invalid data size"));
    }

    if data[0] != VERSION {
        return Err(invalid(format!("unknown version {}", data[0])));
    }

    let nonce: [u8; 32] = data[1..33]
        .try_into()
        .map_err(|_| invalid("invalid data size"))?;
    let mac_offset = data.len() - 32;
    let ciphertext = &data[33..mac_offset];
    let tag = &data[mac_offset..];

    let keys = message_keys(conversation_key, &nonce)?;

    let mut verifier = HmacSha256::new_from_slice(&keys.mac)
        .map_err(|error| CoreError::InvalidNip44(format!("invalid key length: {error}")))?;
    verifier.update(&nonce);
    verifier.update(ciphertext);
    verifier
        .verify_slice(tag)
        .map_err(|_| invalid("invalid MAC"))?;

    let mut padded = ciphertext.to_vec();
    let mut cipher = ChaCha20::new_from_slices(&keys.key, &keys.nonce)
        .map_err(|error| CoreError::InvalidNip44(format!("invalid key length: {error}")))?;
    cipher.apply_keystream(&mut padded);

    unpad(&padded)
}

/// Checks a payload's structure without decrypting it (`validateNip44Payload`,
/// `src/utils/nip44.ts:158-180`). `None` means the format looks valid.
pub fn validate_payload(payload: &str) -> Option<String> {
    if payload.is_empty() || payload.starts_with('#') {
        return Some("unsupported encryption version".to_owned());
    }

    if payload.len() < MIN_PAYLOAD_LENGTH || payload.len() > MAX_PAYLOAD_LENGTH {
        return Some("invalid payload size".to_owned());
    }

    if !payload.len().is_multiple_of(4) || !is_base64(payload) {
        return Some("payload is not valid base64".to_owned());
    }

    let data = STANDARD.decode(payload).ok()?;

    if data.len() < MIN_DATA_LENGTH || data.len() > MAX_DATA_LENGTH {
        return Some("invalid decoded payload size".to_owned());
    }

    if data[0] != VERSION {
        return Some(format!("unsupported encryption version {}", data[0]));
    }

    None
}

/// The length a plaintext of `unpadded_len` bytes is padded to (`calcPaddedLen`,
/// `src/utils/nip44.ts:63-71`).
fn calc_padded_len(unpadded_len: usize) -> usize {
    if unpadded_len <= 32 {
        return 32;
    }

    let next_power = unpadded_len.next_power_of_two();
    let chunk = if next_power <= 256 {
        32
    } else {
        next_power / 8
    };

    chunk * ((unpadded_len - 1) / chunk + 1)
}

/// `u16` big-endian length prefix, the plaintext, then zero padding (`pad`,
/// `src/utils/nip44.ts:72-82`).
fn pad(plaintext: &str) -> Result<Vec<u8>, CoreError> {
    let unpadded = plaintext.as_bytes();

    if unpadded.len() < MIN_PLAINTEXT_SIZE || unpadded.len() > MAX_PLAINTEXT_SIZE {
        return Err(invalid("invalid plaintext length"));
    }

    let mut padded = Vec::with_capacity(2 + calc_padded_len(unpadded.len()));
    padded.extend_from_slice(&(unpadded.len() as u16).to_be_bytes());
    padded.extend_from_slice(unpadded);
    padded.resize(2 + calc_padded_len(unpadded.len()), 0);

    Ok(padded)
}

/// Reads the length prefix back and checks the padding (`unpad`,
/// `src/utils/nip44.ts:84-91`).
fn unpad(padded: &[u8]) -> Result<String, CoreError> {
    let prefix = padded.get(..2).ok_or_else(|| invalid("invalid padding"))?;
    let unpadded_len = usize::from(u16::from_be_bytes([prefix[0], prefix[1]]));

    if unpadded_len == 0 || padded.len() != 2 + calc_padded_len(unpadded_len) {
        return Err(invalid("invalid padding"));
    }

    let unpadded = padded
        .get(2..2 + unpadded_len)
        .ok_or_else(|| invalid("invalid padding"))?;

    String::from_utf8(unpadded.to_vec()).map_err(|_| invalid("invalid padding"))
}

/// `BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/` (`src/utils/nip44.ts:156`).
fn is_base64(payload: &str) -> bool {
    let body = payload.trim_end_matches('=');

    payload.len() - body.len() <= 2
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::InvalidNip44(message.into())
}

struct MessageKeys {
    key: [u8; 32],
    nonce: [u8; 12],
    mac: [u8; 32],
}

/// HKDF-expand of the conversation key into the ChaCha20 key, its nonce and the MAC key
/// (`getMessageKeys`, `src/utils/nip44.ts:44-61`).
fn message_keys(conversation_key: &[u8; 32], nonce: &[u8; 32]) -> Result<MessageKeys, CoreError> {
    let hkdf = Hkdf::<Sha256>::from_prk(conversation_key)
        .map_err(|error| invalid(format!("invalid conversation key: {error}")))?;

    let mut expanded = [0u8; 76];
    hkdf.expand(nonce, &mut expanded)
        .map_err(|error| invalid(error.to_string()))?;

    let mut keys = MessageKeys {
        key: [0u8; 32],
        nonce: [0u8; 12],
        mac: [0u8; 32],
    };

    keys.key.copy_from_slice(&expanded[0..32]);
    keys.nonce.copy_from_slice(&expanded[32..44]);
    keys.mac.copy_from_slice(&expanded[44..76]);

    Ok(keys)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    const KNOWN_CONVERSATION_KEY: [u8; 32] = [
        0xc4, 0x1c, 0x77, 0x53, 0x56, 0xfd, 0x92, 0xea, 0xdc, 0x63, 0xff, 0x5a, 0x0d, 0xc1, 0xda,
        0x21, 0x1b, 0x26, 0x8c, 0xbe, 0xa2, 0x23, 0x16, 0x76, 0x70, 0x95, 0xb2, 0x87, 0x1e, 0xa1,
        0x41, 0x2d,
    ];
    const KNOWN_PAYLOAD: &str = "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb";

    fn nonce_one() -> [u8; 32] {
        let mut nonce = [0u8; 32];
        nonce[31] = 1;
        nonce
    }

    fn public_key_for(secret: &[u8; 32]) -> Pubkey {
        crate::crypto::public_key(secret).unwrap()
    }

    #[test]
    fn conversation_key_is_symmetric_and_matches_the_published_vector() {
        let mut one = [0u8; 32];
        one[31] = 1;
        let mut two = [0u8; 32];
        two[31] = 2;

        assert_eq!(
            get_conversation_key(&one, &public_key_for(&two)).unwrap(),
            KNOWN_CONVERSATION_KEY
        );
        assert_eq!(
            get_conversation_key(&two, &public_key_for(&one)).unwrap(),
            KNOWN_CONVERSATION_KEY
        );
    }

    #[test]
    fn padded_lengths_follow_the_nip44_table() {
        for (unpadded, expected) in [
            (1, 32),
            (32, 32),
            (33, 64),
            (64, 64),
            (65, 96),
            (100, 128),
            (256, 256),
            (257, 320),
            (512, 512),
            (1024, 1024),
        ] {
            assert_eq!(calc_padded_len(unpadded), expected, "{unpadded}");
        }
    }

    #[test]
    fn published_vector_round_trips() {
        let payload = encrypt("a", &KNOWN_CONVERSATION_KEY, &nonce_one()).unwrap();

        assert_eq!(payload, KNOWN_PAYLOAD);
        assert_eq!(
            decrypt(KNOWN_PAYLOAD, &KNOWN_CONVERSATION_KEY).unwrap(),
            "a"
        );
        assert_eq!(validate_payload(KNOWN_PAYLOAD), None);
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let error = decrypt("dG9vc2hvcnQ=", &KNOWN_CONVERSATION_KEY).unwrap_err();

        assert_eq!(error.to_string(), "invalid payload size");
    }

    #[test]
    fn validate_payload_reports_each_structural_failure() {
        assert_eq!(
            validate_payload("#unsupported"),
            Some("unsupported encryption version".to_owned())
        );
        assert_eq!(
            validate_payload(""),
            Some("unsupported encryption version".to_owned())
        );
        assert_eq!(
            validate_payload("dG9vc2hvcnQ="),
            Some("invalid payload size".to_owned())
        );
    }
}
