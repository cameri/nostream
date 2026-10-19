//! Parity with `test/unit/utils/nip44.spec.ts` (32 mocha cases, measured green at the
//! capture commit `242a3001`): `getConversationKey` (3), `nip44Encrypt` (5),
//! `nip44Decrypt` (7), `validateNip44Payload` (7), and the ten `calc_padded_len` cases
//! (`:180-204`).
//!
//! Re-expression notes: the capture's `nip44Encrypt` defaults its nonce to
//! `randomBytes(32)`; the Rust `encrypt` takes the nonce, so each case that relied on a
//! random one passes a fixed nonce instead — the "valid base64 string" and "different
//! ciphertexts" cases are exactly that re-expression. The ten padding cases observe the
//! padded length through the payload size, as the capture does.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use nostream_core::Pubkey;
use nostream_core::crypto::public_key;
use nostream_core::nip44::{decrypt, encrypt, get_conversation_key, validate_payload};

const KNOWN_CONVERSATION_KEY: &str =
    "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d";
const KNOWN_PAYLOAD: &str = "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb";

fn secret(byte: u8) -> [u8; 32] {
    let mut key = [0u8; 32];
    key[31] = byte;
    key
}

fn public_of(byte: u8) -> Pubkey {
    public_key(&secret(byte)).unwrap()
}

fn conversation_key(secret_byte: u8, peer_byte: u8) -> [u8; 32] {
    get_conversation_key(&secret(secret_byte), &public_of(peer_byte)).unwrap()
}

fn nonce(byte: u8) -> [u8; 32] {
    let mut nonce = [0u8; 32];
    nonce[31] = byte;
    nonce
}

fn payload_len(payload: &str) -> usize {
    STANDARD.decode(payload).unwrap().len()
}

// --- getConversationKey (3) --------------------------------------------------------------

#[test]
fn derives_the_correct_conversation_key_from_sec1_and_pub2() {
    let key = conversation_key(1, 2);

    assert_eq!(
        key.iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
        KNOWN_CONVERSATION_KEY
    );
}

#[test]
fn is_symmetric_conv_a_b_eq_conv_b_a() {
    assert_eq!(conversation_key(1, 2), conversation_key(2, 1));
}

#[test]
fn produces_different_keys_for_different_key_pairs() {
    assert_ne!(conversation_key(1, 2), conversation_key(1, 3));
}

// --- nip44Encrypt (5) --------------------------------------------------------------------

#[test]
fn produces_the_canonical_payload_from_the_nip44_spec_test_vector() {
    let key = conversation_key(1, 2);

    assert_eq!(encrypt("a", &key, &nonce(1)).unwrap(), KNOWN_PAYLOAD);
}

#[test]
fn produces_a_valid_base64_string_starting_with_version_byte_0x02() {
    let key = conversation_key(1, 2);
    let payload = encrypt("hello", &key, &nonce(1)).unwrap();
    let decoded = STANDARD.decode(&payload).unwrap();

    assert_eq!(decoded[0], 2);
    assert!(payload.len() >= 132 && payload.len() <= 87_472);
}

#[test]
fn produces_different_ciphertexts_for_the_same_plaintext_with_different_nonces() {
    let key = conversation_key(1, 2);
    let first = encrypt("same message", &key, &nonce(1)).unwrap();
    let second = encrypt("same message", &key, &nonce(2)).unwrap();

    assert_ne!(first, second);
}

#[test]
fn throws_for_empty_plaintext() {
    let key = conversation_key(1, 2);
    let error = encrypt("", &key, &nonce(1)).unwrap_err();

    assert_eq!(error.to_string(), "invalid plaintext length");
}

#[test]
fn throws_for_plaintext_exceeding_65535_bytes() {
    let key = conversation_key(1, 2);
    let error = encrypt(&"x".repeat(65_536), &key, &nonce(1)).unwrap_err();

    assert_eq!(error.to_string(), "invalid plaintext length");
}

// --- nip44Decrypt (7) --------------------------------------------------------------------

#[test]
fn decrypts_the_canonical_nip44_spec_test_vector() {
    let key = conversation_key(1, 2);

    assert_eq!(decrypt(KNOWN_PAYLOAD, &key).unwrap(), "a");
}

#[test]
fn round_trips_any_plaintext_through_encrypt_then_decrypt() {
    let key = conversation_key(1, 2);
    let original = "Hola, que tal? 🌍";
    let payload = encrypt(original, &key, &nonce(7)).unwrap();

    assert_eq!(decrypt(&payload, &key).unwrap(), original);
}

#[test]
fn works_with_the_symmetric_key_recipient_decrypts_sender_message() {
    let sender = conversation_key(1, 2);
    let recipient = conversation_key(2, 1);
    let payload = encrypt("secret message", &sender, &nonce(3)).unwrap();

    assert_eq!(decrypt(&payload, &recipient).unwrap(), "secret message");
}

#[test]
fn throws_when_mac_is_tampered() {
    let key = conversation_key(1, 2);
    let payload = encrypt("tamper me", &key, &nonce(4)).unwrap();
    let tampered = format!("{}AAAA", &payload[..payload.len() - 4]);

    assert!(decrypt(&tampered, &key).is_err());
}

#[test]
fn throws_for_payload_starting_with_hash_unsupported_future_version() {
    let key = conversation_key(1, 2);
    let error = decrypt("#not-base64", &key).unwrap_err();

    assert_eq!(error.to_string(), "unknown version");
}

#[test]
fn throws_for_payload_that_is_too_short() {
    let key = conversation_key(1, 2);
    let error = decrypt("dG9vc2hvcnQ=", &key).unwrap_err();

    assert_eq!(error.to_string(), "invalid payload size");
}

#[test]
fn throws_for_wrong_conversation_key() {
    let payload = encrypt("private", &conversation_key(1, 2), &nonce(5)).unwrap();
    let error = decrypt(&payload, &conversation_key(1, 3)).unwrap_err();

    assert_eq!(error.to_string(), "invalid MAC");
}

// --- validateNip44Payload (7) ------------------------------------------------------------

#[test]
fn returns_none_for_a_valid_nip44_v2_payload() {
    assert_eq!(validate_payload(KNOWN_PAYLOAD), None);
}

#[test]
fn returns_none_for_a_freshly_encrypted_payload() {
    let payload = encrypt("hello", &conversation_key(1, 2), &nonce(6)).unwrap();

    assert_eq!(validate_payload(&payload), None);
}

#[test]
fn returns_error_string_for_payload_starting_with_hash() {
    assert_eq!(
        validate_payload("#unsupported"),
        Some("unsupported encryption version".to_owned())
    );
}

#[test]
fn returns_error_string_for_empty_string() {
    assert_eq!(
        validate_payload(""),
        Some("unsupported encryption version".to_owned())
    );
}

#[test]
fn returns_error_string_for_payload_that_is_too_short() {
    assert_eq!(
        validate_payload("dG9vc2hvcnQ="),
        Some("invalid payload size".to_owned())
    );
}

#[test]
fn returns_error_string_for_payload_that_is_too_long() {
    assert_eq!(
        validate_payload(&"A".repeat(87_473)),
        Some("invalid payload size".to_owned())
    );
}

#[test]
fn returns_error_string_when_version_byte_is_not_0x02() {
    let mut data = [0u8; 99];
    data[0] = 0x01;
    let payload = STANDARD.encode(data);

    let error = validate_payload(&payload).unwrap();

    assert!(error.contains("unsupported encryption version"), "{error}");
    assert_eq!(error, "unsupported encryption version 1");
}

// --- padding length (calc_padded_len) (10) -----------------------------------------------

#[test]
fn pads_1_bytes_to_32_bytes() {
    assert_padded(1, 32);
}

#[test]
fn pads_32_bytes_to_32_bytes() {
    assert_padded(32, 32);
}

#[test]
fn pads_33_bytes_to_64_bytes() {
    assert_padded(33, 64);
}

#[test]
fn pads_64_bytes_to_64_bytes() {
    assert_padded(64, 64);
}

#[test]
fn pads_65_bytes_to_96_bytes() {
    assert_padded(65, 96);
}

#[test]
fn pads_100_bytes_to_128_bytes() {
    assert_padded(100, 128);
}

#[test]
fn pads_256_bytes_to_256_bytes() {
    assert_padded(256, 256);
}

#[test]
fn pads_257_bytes_to_320_bytes() {
    assert_padded(257, 320);
}

#[test]
fn pads_512_bytes_to_512_bytes() {
    assert_padded(512, 512);
}

#[test]
fn pads_1024_bytes_to_1024_bytes() {
    assert_padded(1024, 1024);
}

/// The capture's observation: layout is 1 (version) + 32 (nonce) + padded length + 2 that
/// the padded buffer occupies, 32 (MAC) last (`nip44.spec.ts:193-204`).
fn assert_padded(unpadded_len: usize, expected_padded_len: usize) {
    let key = conversation_key(1, 2);
    let payload = encrypt(&"a".repeat(unpadded_len), &key, &nonce(9)).unwrap();
    let padded_with_prefix = payload_len(&payload) - 1 - 32 - 32;

    assert_eq!(padded_with_prefix, expected_padded_len + 2);
}
