//! Event signing and hashing. Mirrors `src/utils/event.ts` (`getEventHash`,
//! `isEventIdValid`, `isEventSignatureValid`, `getPublicKey`, `signEvent`).
//!
//! The id is SHA-256 over the canonical serialization (`src/utils/event.ts:121-125`) and
//! the signature is BIP-340 Schnorr over that id. `secp256k1` appears in no public
//! signature: the wire types here are `nostream-core`'s own.
//!
//! Signing is deterministic (`sign_no_aux_rand`). The capture signs through noble's
//! default random auxiliary data (`@noble/secp256k1` 1.7.1), which makes its signatures
//! non-reproducible; BIP-340 verifies both, so the difference is unobservable on the wire.

use secp256k1::{Keypair, Parity, PublicKey, SecretKey, XOnlyPublicKey, ecdh, schnorr};
use sha2::{Digest, Sha256};

use crate::error::CoreError;
use crate::event::{Event, EventId, Pubkey, Signature, canonical_json};

/// The id of an event: SHA-256 over `[0, pubkey, created_at, kind, tags, content]`
/// (`getEventHash`, `src/utils/event.ts:121-125`).
pub fn compute_event_id(event: &Event) -> Result<EventId, CoreError> {
    let digest = Sha256::digest(canonical_json(event)?.as_bytes());

    let mut id = [0u8; 32];
    id.copy_from_slice(&digest);

    Ok(EventId::from_byte_array(id))
}

/// Verifies the BIP-340 signature over the event id (`isEventSignatureValid`,
/// `src/utils/event.ts:131-133`).
pub fn verify_event_signature(event: &Event) -> Result<(), CoreError> {
    let public_key = XOnlyPublicKey::from_byte_array(*event.pubkey.as_bytes())
        .map_err(|error| CoreError::InvalidEvent(format!("pubkey: {error}")))?;

    schnorr::Signature::from_byte_array(*event.sig.as_bytes())
        .verify(event.id.as_bytes(), &public_key)
        .map_err(|_| CoreError::InvalidSignature)
}

/// Produces a complete, valid event from a 32-byte secret key (`signEvent`,
/// `src/utils/event.ts:169-174`): the author, the id and then the signature over it.
///
/// The capture's `signEvent` takes an id it was handed and leaves `pubkey` alone, so a
/// caller that pairs it with the wrong key gets a signature that verifies over the id but
/// not against the event's own pubkey. Here the pubkey is set from the key, because the id
/// is hashed over the pubkey and a returned event must verify.
pub fn sign_event(secret_key: &[u8; 32], event: &mut Event) -> Result<(), CoreError> {
    let keypair = keypair(secret_key)?;
    let (public_key, _parity) = keypair.x_only_public_key();

    event.pubkey = Pubkey::from_byte_array(public_key.to_byte_array());
    event.id = compute_event_id(event)?;
    let signature = schnorr::sign_no_aux_rand(event.id.as_bytes(), &keypair);
    event.sig = Signature::from_byte_array(*signature.as_byte_array());

    Ok(())
}

/// The x-only public key for a 32-byte secret key (`getPublicKey`,
/// `src/utils/event.ts:159-167`, which drops the compressed key's parity byte).
pub fn public_key(secret_key: &[u8; 32]) -> Result<Pubkey, CoreError> {
    let (public_key, _parity) = keypair(secret_key)?.x_only_public_key();

    Ok(Pubkey::from_byte_array(public_key.to_byte_array()))
}

/// The x-coordinate of the ECDH shared point, which NIP-44 hashes into the conversation
/// key (`getConversationKey`, `src/utils/nip44.ts:36-42`). The peer's key is the x-only
/// wire form, so it is lifted with even parity, as the capture's `02`-prefixed key is.
pub(crate) fn shared_secret_x(secret_key: &[u8; 32], peer: &Pubkey) -> Result<[u8; 32], CoreError> {
    let secret = SecretKey::from_secret_bytes(*secret_key)
        .map_err(|error| CoreError::InvalidEvent(format!("secret key: {error}")))?;
    let x_only = XOnlyPublicKey::from_byte_array(*peer.as_bytes())
        .map_err(|error| CoreError::InvalidEvent(format!("pubkey: {error}")))?;
    let point = PublicKey::from_x_only_public_key(x_only, Parity::Even);

    let point = ecdh::shared_secret_point(&point, &secret);
    let mut x = [0u8; 32];
    x.copy_from_slice(&point[..32]);

    Ok(x)
}

fn keypair(secret_key: &[u8; 32]) -> Result<Keypair, CoreError> {
    let secret = SecretKey::from_secret_bytes(*secret_key)
        .map_err(|error| CoreError::InvalidEvent(format!("secret key: {error}")))?;

    Ok(Keypair::from_secret_key(&secret))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::event::Kind;

    const ID: &str = "b1601d26958e6508b7b9df0af609c652346c09392b6534d93aead9819a51b4ef";
    const PUBKEY: &str = "22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793";
    const SIG: &str = "ec8b2bc640c8c7e92fbc0e0a6f539da2635068a99809186f15106174d727456132977c78f3371d0ab01c108173df75750f33d8e04c4d7980bbb3fb70ba1e3848";

    /// `test/unit/utils/event.spec.ts:265-330`.
    fn known_event() -> Event {
        Event {
            id: ID.parse().unwrap(),
            pubkey: PUBKEY.parse().unwrap(),
            created_at: 1_648_339_664,
            kind: Kind::TEXT_NOTE,
            tags: Vec::new(),
            content: "learning terraform rn!".to_owned(),
            sig: SIG.parse().unwrap(),
        }
    }

    /// An event whose pubkey is the signer's, with id and signature still to be filled.
    fn signed_candidate(secret: &[u8; 32]) -> Event {
        Event {
            id: crate::event::EventId::from_byte_array([0; 32]),
            pubkey: public_key(secret).unwrap(),
            created_at: 1_700_000_000,
            kind: Kind::TEXT_NOTE,
            tags: vec![vec!["t".to_owned(), "nostr".to_owned()]],
            content: "signed in the test".to_owned(),
            sig: crate::event::Signature::from_byte_array([0; 64]),
        }
    }

    #[test]
    fn known_vector_id_recomputes() {
        assert_eq!(compute_event_id(&known_event()).unwrap().to_string(), ID);
    }

    #[test]
    fn known_vector_signature_verifies() {
        assert!(verify_event_signature(&known_event()).is_ok());
    }

    #[test]
    fn changed_id_fails_verification() {
        let mut event = known_event();
        event.id = "1234567890123456789012345678901234567890123456789012345678901234"
            .parse()
            .unwrap();

        assert!(matches!(
            verify_event_signature(&event),
            Err(CoreError::InvalidSignature)
        ));
    }

    #[test]
    fn signed_event_verifies_itself_and_is_reproducible() {
        let secret = [1u8; 32];
        let mut event = signed_candidate(&secret);
        let mut again = signed_candidate(&secret);

        sign_event(&secret, &mut event).unwrap();
        sign_event(&secret, &mut again).unwrap();

        assert_eq!(event.id, again.id);
        assert_eq!(event.sig, again.sig);
        assert!(verify_event_signature(&event).is_ok());
    }

    #[test]
    fn signing_sets_the_author_so_a_mismatched_pubkey_cannot_be_signed() {
        let secret = [2u8; 32];
        let mut event = signed_candidate(&secret);
        // Whatever the caller put here, signing makes it the signer's key.
        event.pubkey = public_key(&[7u8; 32]).unwrap();

        sign_event(&secret, &mut event).unwrap();

        assert_eq!(event.pubkey, public_key(&secret).unwrap());
        assert!(verify_event_signature(&event).is_ok());
    }

    #[test]
    fn public_key_of_secret_one_is_the_generator() {
        let mut secret = [0u8; 32];
        secret[31] = 1;

        assert_eq!(
            public_key(&secret).unwrap().to_string(),
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        );
    }

    #[test]
    fn an_unreachable_secret_key_is_an_invalid_event() {
        let zero = [0u8; 32];

        assert!(public_key(&zero).is_err());
    }
}
