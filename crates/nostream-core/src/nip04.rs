//! NIP-04 encrypted direct messages. Mirrors the encryption NIP-47 uses for its wallet
//! request and reply content (`src/payments-processors/nwc-payments-processor.ts`'s
//! `@getalby/sdk` client, whose default is NIP-04).
//!
//! The key is the 32-byte ECDH x-coordinate, the IV is 16 random bytes, the cipher is
//! AES-256-CBC with PKCS#7 padding, and the payload is
//! `<base64 ciphertext>?iv=<base64 iv>`.

use aes::Aes256;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use cbc::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};

use crate::crypto::shared_secret_x;
use crate::error::CoreError;
use crate::event::Pubkey;

type Encryptor = cbc::Encryptor<Aes256>;
type Decryptor = cbc::Decryptor<Aes256>;

/// Encrypts `plaintext` for `peer` (`nip04.encrypt`).
pub fn encrypt(
    secret_key: &[u8; 32],
    peer: &Pubkey,
    plaintext: &str,
    iv: &[u8; 16],
) -> Result<String, CoreError> {
    let key = shared_secret_x(secret_key, peer)?;
    let ciphertext = Encryptor::new(&key.into(), &(*iv).into())
        .encrypt_padded_vec_mut::<Pkcs7>(plaintext.as_bytes());

    Ok(format!("{}?iv={}", STANDARD.encode(ciphertext), STANDARD.encode(iv)))
}

/// Decrypts a NIP-04 payload from `peer` (`nip04.decrypt`).
pub fn decrypt(secret_key: &[u8; 32], peer: &Pubkey, payload: &str) -> Result<String, CoreError> {
    let (ciphertext, iv) = payload
        .split_once("?iv=")
        .ok_or_else(|| CoreError::InvalidNip44("nip04 payload has no iv".to_owned()))?;

    let ciphertext = STANDARD
        .decode(ciphertext)
        .map_err(|error| CoreError::InvalidNip44(format!("nip04 ciphertext: {error}")))?;
    let iv = STANDARD
        .decode(iv)
        .map_err(|error| CoreError::InvalidNip44(format!("nip04 iv: {error}")))?;
    let iv: [u8; 16] = iv
        .try_into()
        .map_err(|iv: Vec<u8>| CoreError::InvalidNip44(format!("nip04 iv is {} bytes", iv.len())))?;

    let key = shared_secret_x(secret_key, peer)?;
    let plaintext = Decryptor::new(&key.into(), &iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(&ciphertext)
        .map_err(|error| CoreError::InvalidNip44(format!("nip04 plaintext: {error}")))?;

    String::from_utf8(plaintext)
        .map_err(|error| CoreError::InvalidNip44(format!("nip04 plaintext: {error}")))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::crypto::public_key;

    #[test]
    fn a_message_round_trips_between_the_two_parties() {
        let alice = [1u8; 32];
        let bob = [2u8; 32];
        let alice_public = public_key(&alice).expect("alice's pubkey");
        let bob_public = public_key(&bob).expect("bob's pubkey");

        let payload = encrypt(&alice, &bob_public, "hello bob", &[7u8; 16]).expect("encrypt");

        assert!(payload.contains("?iv="));
        assert_eq!(
            decrypt(&bob, &alice_public, &payload).expect("decrypt"),
            "hello bob"
        );
    }
}
