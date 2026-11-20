//! NIP-19: the bech32 forms a human types where a hex value belongs.
//!
//! Mirrors `fromBech32` (`src/utils/transform.ts`) and the one caller the CLI has for it:
//! `parseRelayPubkey` (`src/utils/nip43-invites.ts:29-47`) accepts an `npub1…` where a settings
//! file holds `info.self`, so an operator may write either form. Only the public key is decoded
//! here; `nsec`/`note`/`nprofile` are the relay's to add when a caller needs them, and adding one
//! without a caller would be a decoder nobody has exercised.

use crate::error::CoreError;

/// The 32 bytes a NIP-19 `npub` encodes.
///
/// A `bech32` failure, a foreign human-readable part and a payload of the wrong length are one
/// answer on purpose: the caller has one message for all three (`info.self npub did not decode to
/// a 32-byte pubkey`), and a caller that needs to tell them apart does not exist.
pub fn decode_npub(value: &str) -> Result<[u8; 32], CoreError> {
    let (hrp, data) = bech32::decode(value).map_err(|error| {
        CoreError::InvalidMessage(format!("nip19: `{value}` is not bech32: {error}"))
    })?;

    if !hrp.as_str().eq_ignore_ascii_case("npub") {
        return Err(CoreError::InvalidMessage(format!(
            "nip19: `{value}` is `{}`, not an npub",
            hrp.as_str()
        )));
    }

    data.try_into().map_err(|data: Vec<u8>| {
        CoreError::InvalidMessage(format!(
            "nip19: `{value}` decoded to {} bytes, not 32",
            data.len()
        ))
    })
}

/// Decodes one `npub1…` to its lowercase hex form, the spelling the capture stores.
pub fn decode_npub_hex(value: &str) -> Result<String, CoreError> {
    Ok(hex::encode(decode_npub(value)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fixture pair the CLI's criterion names (`test/unit/utils/nip43-invites.spec.ts:29,75-89`).
    const NPUB: &str = "npub1yt5qf5nw694k3k6jt8ncgj0fdk4463jv3arshk37kxnsgeljc7fsmhwffw";
    const HEX: &str = "22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793";

    #[test]
    fn an_npub_decodes_to_its_hex_form() {
        assert_eq!(decode_npub_hex(NPUB).expect("the fixture decodes"), HEX);
    }

    #[test]
    fn the_hex_form_round_trips_through_bech32() {
        let bytes = decode_npub(NPUB).expect("the fixture decodes");
        let encoded =
            bech32::encode::<bech32::Bech32>(bech32::Hrp::parse("npub").expect("a hrp"), &bytes)
                .expect("the bytes encode");
        assert_eq!(encoded, NPUB);
    }

    #[test]
    fn a_malformed_npub_is_refused() {
        assert!(decode_npub("npub1invalid").is_err());
        assert!(decode_npub("not-bech32").is_err());
    }

    #[test]
    fn a_payload_of_the_wrong_length_is_refused() {
        let short = bech32::encode::<bech32::Bech32>(
            bech32::Hrp::parse("npub").expect("a hrp"),
            &[1u8; 16],
        )
        .expect("the bytes encode");
        assert!(decode_npub(&short).is_err());
    }

    #[test]
    fn another_prefix_is_refused() {
        let note = bech32::encode::<bech32::Bech32>(
            bech32::Hrp::parse("note").expect("a hrp"),
            &[2u8; 32],
        )
        .expect("the bytes encode");
        assert!(decode_npub(&note).is_err());
    }
}
