//! NIP-03: OpenTimestamps attestations. Mirrors `src/utils/nip03.ts`.
//!
//! A relay cannot verify a proof against the Bitcoin chain — that needs a node, and clients do
//! it themselves — so this is a *structural* validator: the magic header, the version, the file
//! hash op, the digest, and the shape of the commitment tree, then the three relay-observable
//! requirements of NIP-03 (a sha256 file hash, a digest equal to the attested event id, and at
//! least one Bitcoin block-header attestation).
//!
//! Every rejection is a reason string, and they are the capture's verbatim, because the
//! kind-1040 strategy puts them in the event's `OK` frame after `invalid: `.

use base64::Engine;
use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};

use crate::constants::MAX_SAFE_INTEGER;
use crate::event::EventId;

/// The 31-byte magic header (`MAGIC_HEADER`, `src/utils/nip03.ts:27-30`).
const MAGIC_HEADER: [u8; 31] = [
    0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
    0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
];

/// The 8-byte attestation type tags (`src/utils/nip03.ts:34-37`).
const BITCOIN_BLOCK_HEADER_ATTESTATION: [u8; 8] = [0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01];
const PENDING_ATTESTATION: [u8; 8] = [0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e];
const LITECOIN_BLOCK_HEADER_ATTESTATION: [u8; 8] = [0x06, 0x86, 0x9a, 0x0d, 0x73, 0xd7, 0x1b, 0x45];
const ETHEREUM_BLOCK_HEADER_ATTESTATION: [u8; 8] = [0x30, 0xfe, 0x80, 0x87, 0xb5, 0xc7, 0xea, 0xd7];

/// Operation tag bytes used in the commitment tree (`src/utils/nip03.ts:40-47`).
const OP_SHA1: u8 = 0x02;
const OP_RIPEMD160: u8 = 0x03;
const OP_SHA256: u8 = 0x08;
const OP_KECCAK256: u8 = 0x67;
const OP_APPEND: u8 = 0xf0;
const OP_PREPEND: u8 = 0xf1;
const OP_REVERSE: u8 = 0xf2;
const OP_HEXLIFY: u8 = 0xf3;

/// The two structural markers in a `Timestamp` node (`src/utils/nip03.ts:50-51`).
const TAG_BRANCH: u8 = 0xff;
const TAG_ATTESTATION: u8 = 0x00;

/// The ceilings that keep a pathological proof from exhausting memory or the stack
/// (`src/utils/nip03.ts:57-60`).
const MAX_OTS_BYTES: usize = 16 * 1024;
const MAX_VARBYTES_LENGTH: usize = 8 * 1024;
const MAX_RECURSION_DEPTH: usize = 128;

/// Only v1 of the file format is defined today (`src/utils/nip03.ts:65`).
const SUPPORTED_OTS_VERSION: u64 = 1;

/// The hash op a proof's header names for the timestamped file (`OtsFileSummary.fileHashOp`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileHashOp {
    Sha1,
    Ripemd160,
    Sha256,
    Keccak256,
}

impl FileHashOp {
    /// The spelling the capture's summary reports, and the one its reason strings carry.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sha1 => "sha1",
            Self::Ripemd160 => "ripemd160",
            Self::Sha256 => "sha256",
            Self::Keccak256 => "keccak256",
        }
    }

    /// The digest length this op produces (`parseFileHashOp`, `src/utils/nip03.ts:279-292`).
    const fn digest_length(self) -> usize {
        match self {
            Self::Sha1 | Self::Ripemd160 => 20,
            Self::Sha256 | Self::Keccak256 => 32,
        }
    }
}

/// The chain an attestation commits to. An unrecognised tag is `Unknown` rather than a
/// hard failure: the format is explicitly extensible (`src/utils/nip03.ts:67-74`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OtsAttestationKind {
    Bitcoin,
    Pending,
    Litecoin,
    Ethereum,
    Unknown,
}

/// One attestation found in the commitment tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OtsAttestation {
    pub kind: OtsAttestationKind,
    /// The block height a block-header attestation carries, when it parsed cleanly.
    pub height: Option<u64>,
}

/// What a parsed `.ots` file says (`OtsFileSummary`, `src/utils/nip03.ts:92-100`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OtsSummary {
    pub version: u64,
    pub file_hash_op: FileHashOp,
    /// The timestamped file's digest: 20 bytes for sha1/ripemd160, 32 for sha256/keccak256.
    pub digest: Vec<u8>,
    pub attestations: Vec<OtsAttestation>,
}

/// Parses a binary `.ots` file (`parseOtsFile`, `src/utils/nip03.ts:298-344`).
///
/// The capture never throws — it returns a result union — so every malformed input is an
/// `Err` carrying the capture's reason.
pub fn parse_ots_file(bytes: &[u8]) -> Result<OtsSummary, String> {
    if bytes.is_empty() {
        return Err("empty ots file".to_owned());
    }

    if bytes.len() > MAX_OTS_BYTES {
        return Err(format!("ots file exceeds {MAX_OTS_BYTES} bytes"));
    }

    let mut reader = Reader::new(bytes);

    if reader.read_bytes(MAGIC_HEADER.len())? != MAGIC_HEADER.as_slice() {
        return Err("invalid ots magic header".to_owned());
    }

    let version = reader.read_varuint()?;

    if version != SUPPORTED_OTS_VERSION {
        return Err(format!("unsupported ots version {version}"));
    }

    let file_hash_op = parse_file_hash_op(reader.read_byte()?)?;
    let digest = reader.read_bytes(file_hash_op.digest_length())?.to_vec();

    let mut attestations = Vec::new();
    read_timestamp(&mut reader, &mut attestations, 0)?;

    if reader.remaining() != 0 {
        return Err(format!(
            "trailing bytes after ots proof ({} left)",
            reader.remaining()
        ));
    }

    Ok(OtsSummary {
        version,
        file_hash_op,
        digest,
        attestations,
    })
}

/// The capture decodes with Node's permissive `Buffer.from(content, 'base64')`, which discards
/// the final block's unused trailing bits (`src/utils/nip03.ts:368`). The strict `STANDARD`
/// engine refuses such a proof, which the capture accepts — a wire-visible
/// `invalid: content is not valid base64` for a proof that is structurally sound.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
);

/// Validates the base64-encoded `.ots` proof in a kind-1040 event's content
/// (`validateOtsProof`, `src/utils/nip03.ts:357-396`).
///
/// The capture's five rules, in its order: a non-empty content, the base64 guard, a sha256
/// file hash, a digest equal to the attested event id, and at least one Bitcoin attestation.
/// The capture's sixth check — that the target id is 32 hex bytes — is carried by
/// [`EventId`]'s type here, so it has no runtime form.
pub fn validate_ots_proof(base64_content: &str, target_event_id: &EventId) -> Result<(), String> {
    if base64_content.is_empty() {
        return Err("content is empty; expected base64-encoded ots file".to_owned());
    }

    // Node's permissive decoder silently drops bad characters; the capture fails loudly
    // instead, so a client gets a reason rather than a proof that "parsed".
    if !is_base64(base64_content) || !base64_content.len().is_multiple_of(4) {
        return Err("content is not valid base64".to_owned());
    }

    let bytes = LENIENT
        .decode(base64_content)
        .map_err(|_| "content is not valid base64".to_owned())?;

    let summary =
        parse_ots_file(&bytes).map_err(|reason| format!("invalid ots proof: {reason}"))?;

    if summary.file_hash_op != FileHashOp::Sha256 {
        return Err(format!(
            "ots proof must use sha256 file hash op (got {})",
            summary.file_hash_op.as_str()
        ));
    }

    if summary.digest.as_slice() != target_event_id.as_bytes().as_slice() {
        return Err("ots proof digest does not match the referenced event id".to_owned());
    }

    if !summary
        .attestations
        .iter()
        .any(|attestation| attestation.kind == OtsAttestationKind::Bitcoin)
    {
        return Err("ots proof must contain at least one bitcoin attestation".to_owned());
    }

    Ok(())
}

/// A bounds-checked cursor over an `.ots` file (`OtsReader`, `src/utils/nip03.ts:110-167`).
struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    const fn remaining(&self) -> usize {
        self.bytes.len() - self.offset
    }

    fn read_bytes(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(count)
            .filter(|end| *end <= self.bytes.len());

        let Some(end) = end else {
            return Err(format!(
                "unexpected end of input (need {count} bytes, have {})",
                self.remaining()
            ));
        };

        let slice = &self.bytes[self.offset..end];
        self.offset = end;

        Ok(slice)
    }

    fn read_byte(&mut self) -> Result<u8, String> {
        Ok(self.read_bytes(1)?[0])
    }

    /// A LEB128 varuint, little-endian base-128 with an MSB continuation bit
    /// (`readVarUint`, `src/utils/nip03.ts:140-158`).
    fn read_varuint(&mut self) -> Result<u64, String> {
        let mut value: u64 = 0;
        let mut shift = 0;

        loop {
            if shift > 56 {
                return Err("varint overflow".to_owned());
            }

            let byte = self.read_byte()?;
            value += u64::from(byte & 0x7f) << shift;

            if byte & 0x80 == 0 {
                break;
            }

            shift += 7;
        }

        if value > MAX_SAFE_INTEGER {
            return Err("varint exceeds safe integer range".to_owned());
        }

        Ok(value)
    }

    fn read_varbytes(&mut self) -> Result<&'a [u8], String> {
        let length = self.read_varuint()?;

        let Ok(length) = usize::try_from(length) else {
            return Err(format!(
                "varbytes length {length} exceeds maximum {MAX_VARBYTES_LENGTH}"
            ));
        };

        if length > MAX_VARBYTES_LENGTH {
            return Err(format!(
                "varbytes length {length} exceeds maximum {MAX_VARBYTES_LENGTH}"
            ));
        }

        self.read_bytes(length)
    }
}

/// `parseFileHashOp` (`src/utils/nip03.ts:279-292`).
fn parse_file_hash_op(op: u8) -> Result<FileHashOp, String> {
    match op {
        OP_SHA1 => Ok(FileHashOp::Sha1),
        OP_RIPEMD160 => Ok(FileHashOp::Ripemd160),
        OP_SHA256 => Ok(FileHashOp::Sha256),
        OP_KECCAK256 => Ok(FileHashOp::Keccak256),
        _ => Err(format!("unsupported file hash op 0x{op:02x}")),
    }
}

/// `classifyAttestationTag` (`src/utils/nip03.ts:169-183`).
fn classify_attestation(tag: &[u8]) -> OtsAttestationKind {
    if tag == BITCOIN_BLOCK_HEADER_ATTESTATION.as_slice() {
        OtsAttestationKind::Bitcoin
    } else if tag == PENDING_ATTESTATION.as_slice() {
        OtsAttestationKind::Pending
    } else if tag == LITECOIN_BLOCK_HEADER_ATTESTATION.as_slice() {
        OtsAttestationKind::Litecoin
    } else if tag == ETHEREUM_BLOCK_HEADER_ATTESTATION.as_slice() {
        OtsAttestationKind::Ethereum
    } else {
        OtsAttestationKind::Unknown
    }
}

/// `readAttestation` (`src/utils/nip03.ts:185-210`): the type tag, then the length-prefixed
/// payload, whose first varuint is the block height for the three block-header chains.
fn read_attestation(reader: &mut Reader<'_>) -> Result<OtsAttestation, String> {
    let tag = reader.read_bytes(8)?;
    let kind = classify_attestation(tag);
    let payload = reader.read_varbytes()?;

    let height = match kind {
        OtsAttestationKind::Bitcoin
        | OtsAttestationKind::Litecoin
        | OtsAttestationKind::Ethereum => Reader::new(payload).read_varuint().ok(),
        OtsAttestationKind::Pending | OtsAttestationKind::Unknown => None,
    };

    Ok(OtsAttestation { kind, height })
}

/// `readOpArgIfAny` (`src/utils/nip03.ts:227-239`).
fn skip_op_argument(reader: &mut Reader<'_>, op: u8) -> Result<(), String> {
    if op == OP_APPEND || op == OP_PREPEND {
        // A binary op carries one length-prefixed argument, which the validator skips over;
        // `read_varbytes` still enforces the length ceiling.
        reader.read_varbytes()?;

        return Ok(());
    }

    if matches!(
        op,
        OP_SHA1 | OP_RIPEMD160 | OP_SHA256 | OP_KECCAK256 | OP_REVERSE | OP_HEXLIFY
    ) {
        return Ok(());
    }

    Err(format!("unknown op tag 0x{op:02x}"))
}

/// `readTimestamp` (`src/utils/nip03.ts:251-268`):
/// `Timestamp := (0xff SubItem)* SubItem`.
fn read_timestamp(
    reader: &mut Reader<'_>,
    attestations: &mut Vec<OtsAttestation>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_RECURSION_DEPTH {
        return Err(format!("timestamp tree too deep (>{MAX_RECURSION_DEPTH})"));
    }

    loop {
        let tag = reader.read_byte()?;

        if tag == TAG_BRANCH {
            let inner = reader.read_byte()?;
            read_sub_item(reader, inner, attestations, depth + 1)?;

            continue;
        }

        return read_sub_item(reader, tag, attestations, depth + 1);
    }
}

/// `readSubItem` (`src/utils/nip03.ts:270-277`): an attestation leaf, or an inner commitment.
fn read_sub_item(
    reader: &mut Reader<'_>,
    tag: u8,
    attestations: &mut Vec<OtsAttestation>,
    depth: usize,
) -> Result<(), String> {
    if tag == TAG_ATTESTATION {
        attestations.push(read_attestation(reader)?);

        return Ok(());
    }

    skip_op_argument(reader, tag)?;
    read_timestamp(reader, attestations, depth)
}

/// `^[A-Za-z0-9+/]+={0,2}$` (`src/utils/nip03.ts:364`).
fn is_base64(value: &str) -> bool {
    let body = value.trim_end_matches('=');

    !body.is_empty()
        && value.len() - body.len() <= 2
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use base64::engine::general_purpose::STANDARD;

    const TARGET: &str = "e71c6ea722987debdb60f81f9ea4f604b5ac0664120dd64fb9d23abc4ec7c323";

    /// The eight-byte Bitcoin block-header attestation tag.
    const BITCOIN_TAG: [u8; 8] = [0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01];
    /// The eight-byte Litecoin block-header attestation tag.
    const LITECOIN_TAG: [u8; 8] = [0x06, 0x86, 0x9a, 0x0d, 0x73, 0xd7, 0x1b, 0x45];

    fn write_varuint(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();

        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;

            if value != 0 {
                byte |= 0x80;
            }

            out.push(byte);

            if value == 0 {
                return out;
            }
        }
    }

    fn attestation(tag: [u8; 8], height: u64) -> Vec<u8> {
        let payload = write_varuint(height);
        let mut bytes = vec![TAG_ATTESTATION];
        bytes.extend(tag);
        bytes.extend(write_varuint(payload.len() as u64));
        bytes.extend(payload);

        bytes
    }

    /// A proof whose digest is `digest` and whose single leaf is a Bitcoin attestation
    /// (`buildValidOtsForDigest`, `timestamp-event-strategy.spec.ts:56-60`).
    fn proof_for(digest: &[u8]) -> Vec<u8> {
        let mut bytes = MAGIC_HEADER.to_vec();
        bytes.push(1);
        bytes.push(OP_SHA256);
        bytes.extend(digest);
        bytes.extend(attestation(BITCOIN_TAG, 810_391));

        bytes
    }

    fn target_id() -> EventId {
        TARGET.parse().unwrap()
    }

    fn base64(bytes: &[u8]) -> String {
        STANDARD.encode(bytes)
    }

    #[test]
    fn a_bitcoin_attestation_parses_with_its_height() {
        let summary = parse_ots_file(&proof_for(target_id().as_bytes())).unwrap();

        assert_eq!(summary.version, 1);
        assert_eq!(summary.file_hash_op, FileHashOp::Sha256);
        assert_eq!(summary.digest, target_id().as_bytes().to_vec());
        assert_eq!(
            summary.attestations,
            vec![OtsAttestation {
                kind: OtsAttestationKind::Bitcoin,
                height: Some(810_391),
            }]
        );
    }

    #[test]
    fn a_branch_is_walked_and_every_leaf_collected() {
        let mut bytes = MAGIC_HEADER.to_vec();
        bytes.push(1);
        bytes.push(OP_SHA256);
        bytes.extend(target_id().as_bytes());
        // `(0xff SubItem)* SubItem`: a branch over a unary op and a Litecoin leaf, then the
        // final sub-item, a Bitcoin leaf.
        bytes.push(TAG_BRANCH);
        bytes.push(OP_REVERSE);
        bytes.extend(attestation(LITECOIN_TAG, 7));
        bytes.extend(attestation(BITCOIN_TAG, 810_391));

        let summary = parse_ots_file(&bytes).unwrap();

        assert_eq!(
            summary.attestations,
            vec![
                OtsAttestation {
                    kind: OtsAttestationKind::Litecoin,
                    height: Some(7),
                },
                OtsAttestation {
                    kind: OtsAttestationKind::Bitcoin,
                    height: Some(810_391),
                },
            ]
        );
    }

    #[test]
    fn the_magic_header_is_required() {
        let mut bytes = proof_for(target_id().as_bytes());
        bytes[0] = 0xff;

        assert_eq!(
            parse_ots_file(&bytes),
            Err("invalid ots magic header".to_owned())
        );
    }

    #[test]
    fn an_unsupported_version_is_refused() {
        let mut bytes = proof_for(target_id().as_bytes());
        bytes[MAGIC_HEADER.len()] = 2;

        assert_eq!(
            parse_ots_file(&bytes),
            Err("unsupported ots version 2".to_owned())
        );
    }

    #[test]
    fn an_unsupported_file_hash_op_is_refused() {
        let mut bytes = proof_for(target_id().as_bytes());
        bytes[MAGIC_HEADER.len() + 1] = 0x42;

        assert_eq!(
            parse_ots_file(&bytes),
            Err("unsupported file hash op 0x42".to_owned())
        );
    }

    #[test]
    fn an_empty_file_is_refused() {
        assert_eq!(parse_ots_file(&[]), Err("empty ots file".to_owned()));
    }

    #[test]
    fn an_oversize_file_is_refused() {
        assert_eq!(
            parse_ots_file(&vec![0u8; MAX_OTS_BYTES + 1]),
            Err(format!("ots file exceeds {MAX_OTS_BYTES} bytes"))
        );
    }

    #[test]
    fn a_truncated_file_is_refused() {
        let bytes = proof_for(target_id().as_bytes());

        assert!(
            parse_ots_file(&bytes[..MAGIC_HEADER.len()]).is_err(),
            "a file that ends inside the header has no digest"
        );
    }

    #[test]
    fn trailing_bytes_are_refused() {
        let mut bytes = proof_for(target_id().as_bytes());
        bytes.push(0x00);

        assert_eq!(
            parse_ots_file(&bytes),
            Err("trailing bytes after ots proof (1 left)".to_owned())
        );
    }

    #[test]
    fn an_unknown_op_tag_is_refused() {
        let mut bytes = MAGIC_HEADER.to_vec();
        bytes.push(1);
        bytes.push(OP_SHA256);
        bytes.extend(target_id().as_bytes());
        bytes.push(0x99);

        assert_eq!(
            parse_ots_file(&bytes),
            Err("unknown op tag 0x99".to_owned())
        );
    }

    #[test]
    fn a_varint_that_never_terminates_is_refused() {
        let mut bytes = MAGIC_HEADER.to_vec();
        bytes.extend(std::iter::repeat_n(0x80u8, 9));

        assert_eq!(parse_ots_file(&bytes), Err("varint overflow".to_owned()));
    }

    #[test]
    fn a_tree_past_the_depth_cap_is_refused() {
        let mut bytes = MAGIC_HEADER.to_vec();
        bytes.push(1);
        bytes.push(OP_SHA256);
        bytes.extend(target_id().as_bytes());
        // Each `reverse` (a unary op) adds one level without an argument.
        bytes.extend(std::iter::repeat_n(OP_REVERSE, MAX_RECURSION_DEPTH + 2));

        assert_eq!(
            parse_ots_file(&bytes),
            Err(format!("timestamp tree too deep (>{MAX_RECURSION_DEPTH})"))
        );
    }

    #[test]
    fn a_proof_for_the_wrong_digest_is_refused() {
        let other = [0xd7u8; 32];

        assert_eq!(
            validate_ots_proof(&base64(&proof_for(&other)), &target_id()),
            Err("ots proof digest does not match the referenced event id".to_owned())
        );
    }

    #[test]
    fn a_proof_without_a_bitcoin_attestation_is_refused() {
        let mut bytes = MAGIC_HEADER.to_vec();
        bytes.push(1);
        bytes.push(OP_SHA256);
        bytes.extend(target_id().as_bytes());
        bytes.extend(attestation(LITECOIN_TAG, 7));

        assert_eq!(
            validate_ots_proof(&base64(&bytes), &target_id()),
            Err("ots proof must contain at least one bitcoin attestation".to_owned())
        );
    }

    #[test]
    fn a_proof_that_is_not_sha256_is_refused() {
        let mut bytes = MAGIC_HEADER.to_vec();
        bytes.push(1);
        bytes.push(OP_SHA1);
        bytes.extend([0u8; 20]);
        bytes.extend(attestation(BITCOIN_TAG, 1));

        assert_eq!(
            validate_ots_proof(&base64(&bytes), &target_id()),
            Err("ots proof must use sha256 file hash op (got sha1)".to_owned())
        );
    }

    #[test]
    fn empty_content_is_refused() {
        assert_eq!(
            validate_ots_proof("", &target_id()),
            Err("content is empty; expected base64-encoded ots file".to_owned())
        );
    }

    #[test]
    fn content_that_is_not_base64_is_refused() {
        assert_eq!(
            validate_ots_proof("not base64!", &target_id()),
            Err("content is not valid base64".to_owned())
        );
        assert_eq!(
            validate_ots_proof("AAAAA", &target_id()),
            Err("content is not valid base64".to_owned())
        );
    }

    #[test]
    fn content_that_is_not_an_ots_file_is_refused() {
        let content =
            base64(b"this is long enough to reach the header check, but it is not a proof");

        assert_eq!(
            validate_ots_proof(&content, &target_id()),
            Err("invalid ots proof: invalid ots magic header".to_owned())
        );
    }

    #[test]
    fn a_valid_proof_is_accepted() {
        assert_eq!(
            validate_ots_proof(&base64(&proof_for(target_id().as_bytes())), &target_id()),
            Ok(())
        );
    }

    /// Re-encodes the final base64 block with one non-zero pad bit: the byte string is the
    /// same, Node's `Buffer.from` decodes it, and a canonical decoder refuses it.
    fn flip_unused_trailing_bits(encoded: &str) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

        let mut characters: Vec<u8> = encoded.bytes().collect();
        let padding = characters
            .iter()
            .rev()
            .take_while(|byte| **byte == b'=')
            .count();
        assert!(
            padding == 1 || padding == 2,
            "a final group with unused bits"
        );
        let index = characters.len() - padding - 1;
        let value = ALPHABET
            .iter()
            .position(|byte| *byte == characters[index])
            .expect("a base64 data character");

        characters[index] = ALPHABET[value ^ 1];

        String::from_utf8(characters).expect("the alphabet is ASCII")
    }

    #[test]
    fn a_non_canonical_re_encoding_of_a_valid_proof_is_accepted() {
        // The capture decodes with Node's permissive `Buffer.from(content, 'base64')`, which
        // discards the final block's unused bits (`src/utils/nip03.ts:368`), so a proof
        // re-encoded with a set pad bit is accepted. A strict decoder refuses it, and the
        // refusal would reach the client as `invalid: content is not valid base64`.
        //
        // A two-byte block height makes the proof 77 bytes, so its base64 ends in one `=`
        // and the last data character carries the two unused bits this case needs.
        let mut bytes = MAGIC_HEADER.to_vec();
        bytes.push(1);
        bytes.push(OP_SHA256);
        bytes.extend(target_id().as_bytes());
        bytes.extend(attestation(BITCOIN_TAG, 300));

        assert_eq!(bytes.len(), 77);

        let canonical = base64(&bytes);
        let re_encoded = flip_unused_trailing_bits(&canonical);

        assert_ne!(re_encoded, canonical);
        assert_eq!(validate_ots_proof(&canonical, &target_id()), Ok(()));
        assert_eq!(validate_ots_proof(&re_encoded, &target_id()), Ok(()));
        assert!(
            STANDARD.decode(&re_encoded).is_err(),
            "the strict engine refuses the non-canonical encoding"
        );
        assert_eq!(LENIENT.decode(&re_encoded).unwrap(), bytes);
    }
}
