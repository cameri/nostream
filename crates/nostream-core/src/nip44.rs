//! NIP-44: versioned encrypted payloads. Mirrors `src/utils/nip44.ts:1-180`.
//!
//! `base64(0x02 || nonce[32] || ciphertext || mac[32])`, where the ChaCha20 key, its 12-byte
//! nonce and the HMAC-SHA256 key are HKDF-expanded from the conversation key and the
//! per-message nonce, and the plaintext is padded behind a length prefix: two big-endian bytes
//! below 65 536, the six-byte `[0x00, 0x00][u32 big-endian]` form at or above it (`44.md`
//! §"Encryption" step 4). The format's ceiling is that `u32`, so a plaintext may be
//! 4 294 967 295 bytes.
//!
//! The nonce is an argument: the capture generates a random one inside `nip44Encrypt`, and
//! randomness is the relay's to supply (spec D13 for the clock, the same reasoning here).
//!
//! The format's ceiling is not the relay's. A payload that large cannot arrive over a socket:
//! `network.maxPayloadSize` (524288 in the shipped settings,
//! `resources/default-settings.yaml:209`) bounds both the WebSocket message and the frame the
//! relay reads (`crates/nostream-relay/src/transport.rs:49-76`), and an absent or zero value
//! falls back to 131072. Only a non-socket caller, such as `nostream-cli import`, can hand this
//! module something bigger. Taking the format's bound rather than inventing a smaller one is
//! deliberate: `44.md` §"Implementation considerations" asks an implementation for its own
//! maximum, and the transport already is this relay's.

use base64::Engine;
use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
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

/// The format's ceiling, `u32::MAX` (`44.md` §"Details").
const MAX_PLAINTEXT_SIZE: usize = 4_294_967_295;

/// The plaintext length at which the prefix widens to the six-byte form.
const EXTENDED_PREFIX_THRESHOLD: usize = 65_536;

/// The width of the two prefix forms.
const SHORT_PREFIX_LENGTH: usize = 2;
const EXTENDED_PREFIX_LENGTH: usize = 6;

/// The NIP-44 version byte this module writes and accepts.
const VERSION: u8 = 2;

/// The smallest base64 payload length the capture accepts (`src/utils/nip44.ts:120-122`).
const MIN_PAYLOAD_LENGTH: usize = 132;

/// The largest base64 payload length: `MAX_DATA_LENGTH` bytes in whole base64 groups. Public
/// beside [`payload_length_refusal`] so a test can name the ceiling it cannot allocate.
pub const MAX_PAYLOAD_LENGTH: usize = base64_length(MAX_DATA_LENGTH);

/// The smallest decoded payload length the capture accepts (`src/utils/nip44.ts:125-127`).
const MIN_DATA_LENGTH: usize = 99;

/// The largest decoded payload length: version, nonce, prefixed padded plaintext and MAC at
/// [`MAX_PLAINTEXT_SIZE`].
const MAX_DATA_LENGTH: usize =
    1 + 32 + prefix_length(MAX_PLAINTEXT_SIZE) + calc_padded_len(MAX_PLAINTEXT_SIZE) + 32;

/// The prefix width a plaintext of `unpadded_len` bytes is written with.
const fn prefix_length(unpadded_len: usize) -> usize {
    if unpadded_len < EXTENDED_PREFIX_THRESHOLD {
        SHORT_PREFIX_LENGTH
    } else {
        EXTENDED_PREFIX_LENGTH
    }
}

/// The base64 length of `data_len` bytes, rounded up to a whole four-character group.
const fn base64_length(data_len: usize) -> usize {
    data_len.div_ceil(3) * 4
}

/// The capture decodes with Node's lenient `Buffer.from(payload, 'base64')`, which ignores
/// non-canonical trailing bits (`src/utils/nip44.ts:124`). The strict `STANDARD` engine
/// refuses such a payload, and a refusal must never be read as "the format looks valid".
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
);

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

    if let Some(refusal) = payload_length_refusal(payload.len()) {
        return Err(invalid(refusal));
    }

    // The same engine `validate_payload` uses: the capture decodes both with Node's lenient
    // `Buffer.from`, so this must not refuse a payload the validator accepts. The MAC is
    // verified over the decoded bytes below, so the leniency cannot weaken it.
    let data = LENIENT
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

    if let Some(refusal) = payload_length_refusal(payload.len()) {
        return Some(refusal);
    }

    if !payload.len().is_multiple_of(4) || !is_base64(payload) {
        return Some("payload is not valid base64".to_owned());
    }

    let data = match LENIENT.decode(payload) {
        Ok(data) => data,
        // Unreachable once the charset and length checks pass, but a decode failure must
        // still be a refusal: `None` from this function means "the format looks valid".
        Err(_) => return Some("payload is not valid base64".to_owned()),
    };

    if data.len() < MIN_DATA_LENGTH || data.len() > MAX_DATA_LENGTH {
        return Some("invalid decoded payload size".to_owned());
    }

    if data[0] != VERSION {
        return Some(format!("unsupported encryption version {}", data[0]));
    }

    None
}

/// The length a plaintext of `unpadded_len` bytes is padded to (`calcPaddedLen`,
/// `src/utils/nip44.ts:63-71`). `const` so the payload and data ceilings are derived from
/// [`MAX_PLAINTEXT_SIZE`] by the same arithmetic the encoder uses.
const fn calc_padded_len(unpadded_len: usize) -> usize {
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

/// The payload-length half of [`decrypt`] and [`validate_payload`], as a function of the length
/// alone: a caller that asks about a length it cannot allocate gets the same refusal the
/// decoder would give.
///
/// shortcut: public where nothing outside this module and the parity test calls it, because the
/// format's ceiling is 5 726 623 156 base64 characters and no test can build one; fold it back
/// to a private helper when a non-test caller needs the refusal, or when `MAX_PAYLOAD_LENGTH`
/// stops being the assertion the test names.
pub fn payload_length_refusal(length: usize) -> Option<String> {
    (!(MIN_PAYLOAD_LENGTH..=MAX_PAYLOAD_LENGTH).contains(&length))
        .then(|| "invalid payload size".to_owned())
}

/// The plaintext-length half of [`pad`], as a function of the length alone — so the ceiling is
/// reachable by a test that cannot allocate it.
fn check_plaintext_length(length: usize) -> Result<(), CoreError> {
    if !(MIN_PLAINTEXT_SIZE..=MAX_PLAINTEXT_SIZE).contains(&length) {
        return Err(invalid("invalid plaintext length"));
    }

    Ok(())
}

/// The length prefix, the plaintext, then zero padding (`pad`, `src/utils/nip44.ts:72-82`).
/// The prefix is the two-byte `u16` form below 65 536 bytes and the six-byte
/// `[0x00, 0x00][u32 big-endian]` form at or above it (`44.md` §"Encryption" step 4).
fn pad(plaintext: &str) -> Result<Vec<u8>, CoreError> {
    let unpadded = plaintext.as_bytes();
    check_plaintext_length(unpadded.len())?;

    let prefix = prefix_length(unpadded.len());
    let padded_len = prefix + calc_padded_len(unpadded.len());
    let mut padded = Vec::with_capacity(padded_len);

    if prefix == SHORT_PREFIX_LENGTH {
        padded.extend_from_slice(&(unpadded.len() as u16).to_be_bytes());
    } else {
        padded.extend_from_slice(&[0x00, 0x00]);
        padded.extend_from_slice(&(unpadded.len() as u32).to_be_bytes());
    }

    padded.extend_from_slice(unpadded);
    padded.resize(padded_len, 0);

    Ok(padded)
}

/// Reads the length prefix back and checks the padding (`unpad`, `src/utils/nip44.ts:84-91`).
fn unpad(padded: &[u8]) -> Result<String, CoreError> {
    let marker = padded
        .get(..SHORT_PREFIX_LENGTH)
        .ok_or_else(|| invalid("invalid padding"))?;
    let marker = u16::from_be_bytes([marker[0], marker[1]]);

    let (prefix, unpadded_len) = if marker == 0 {
        let extended = padded
            .get(..EXTENDED_PREFIX_LENGTH)
            .ok_or_else(|| invalid("invalid padding"))?;
        let length = u32::from_be_bytes(
            extended[SHORT_PREFIX_LENGTH..]
                .try_into()
                .map_err(|_| invalid("invalid padding"))?,
        );

        (EXTENDED_PREFIX_LENGTH, length as usize)
    } else {
        (SHORT_PREFIX_LENGTH, usize::from(marker))
    };

    // An extended prefix can only describe a length the short form cannot, so a smaller one
    // under it is padding that no `pad` wrote.
    if unpadded_len < MIN_PLAINTEXT_SIZE
        || (prefix == EXTENDED_PREFIX_LENGTH && unpadded_len < EXTENDED_PREFIX_THRESHOLD)
        || padded.len() != prefix + calc_padded_len(unpadded_len)
    {
        return Err(invalid("invalid padding"));
    }

    let unpadded = padded
        .get(prefix..prefix + unpadded_len)
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

    #[test]
    fn the_ceilings_are_derived_from_the_formats_plaintext_ceiling() {
        assert_eq!(MAX_DATA_LENGTH, 4_294_967_367);
        assert_eq!(MAX_PAYLOAD_LENGTH, 5_726_623_156);
        assert_eq!(MAX_PAYLOAD_LENGTH, base64_length(MAX_DATA_LENGTH));
    }

    #[test]
    fn plaintext_lengths_are_checked_at_the_formats_bounds() {
        for (length, allowed) in [
            (0, false),
            (MIN_PLAINTEXT_SIZE, true),
            (65_535, true),
            (65_536, true),
            (MAX_PLAINTEXT_SIZE, true),
            (MAX_PLAINTEXT_SIZE + 1, false),
        ] {
            assert_eq!(
                check_plaintext_length(length).is_ok(),
                allowed,
                "length {length}"
            );
        }
    }

    #[test]
    fn payload_lengths_are_checked_at_the_derived_bounds() {
        for (length, refused) in [
            (MIN_PAYLOAD_LENGTH - 1, true),
            (MIN_PAYLOAD_LENGTH, false),
            (MAX_PAYLOAD_LENGTH, false),
            (MAX_PAYLOAD_LENGTH + 1, true),
        ] {
            assert_eq!(
                payload_length_refusal(length),
                refused.then(|| "invalid payload size".to_owned()),
                "length {length}"
            );
        }
    }

    #[test]
    fn the_prefix_widens_at_65_536_bytes() {
        let short = pad(&"x".repeat(65_535)).unwrap();

        assert_eq!(&short[..2], &[0xff, 0xff]);
        assert_eq!(short.len(), 2 + calc_padded_len(65_535));
        assert_eq!(unpad(&short).unwrap(), "x".repeat(65_535));

        let extended = pad(&"x".repeat(65_536)).unwrap();

        assert_eq!(&extended[..6], &[0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);
        assert_eq!(extended.len(), 6 + calc_padded_len(65_536));
        assert_eq!(unpad(&extended).unwrap(), "x".repeat(65_536));
    }

    #[test]
    fn unpad_rejects_an_extended_prefix_below_the_threshold() {
        // `[0x00, 0x00][u32 = 65 535]` followed by a consistent padding: the length is one the
        // short form carries, so no `pad` wrote this prefix.
        let mut padded = vec![0x00, 0x00, 0x00, 0x00, 0xff, 0xff];
        padded.resize(EXTENDED_PREFIX_LENGTH + calc_padded_len(65_535), 0);

        assert_eq!(unpad(&padded).unwrap_err().to_string(), "invalid padding");
    }

    #[test]
    fn unpad_rejects_a_length_the_padding_does_not_cover() {
        // `[0x00, 0x00][u32 = 100 000]` with 65 536 bytes of padding behind it.
        let mut padded = vec![0x00, 0x00, 0x00, 0x01, 0x86, 0xa0];
        padded.resize(EXTENDED_PREFIX_LENGTH + calc_padded_len(65_536), 0);

        assert_eq!(unpad(&padded).unwrap_err().to_string(), "invalid padding");
    }
}
