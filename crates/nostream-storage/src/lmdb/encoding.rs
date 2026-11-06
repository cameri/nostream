//! Key and value codecs for the LMDB store: the format byte, the fixed event header, the
//! big-endian key layout, timestamp truncation and the hex/tag ranges the event queries seek
//! with. `docs/rewrite/decisions/0010-lmdb-backend.md` records why each shape was chosen.

use std::ops::Bound;

use chrono::{DateTime, Utc};
use nostream_core::{EventId, Pubkey};

use crate::error::StorageError;

/// The first byte of every value in every database (ADR 0003 revisit trigger 6): a row
/// written by a later field set cannot be decoded as this one.
pub(crate) const ROW_FORMAT_VERSION: u8 = 1;

/// The fixed event header before the JSON body: flags, `created_at`, `kind`, `expires_at`,
/// `pubkey` and one reserved byte, so a live test reads at most 55 bytes of a value.
pub(crate) const EVENT_HEADER_LEN: usize = 54;

/// The header's "this row is soft-deleted" bit.
const FLAG_DELETED: u8 = 1;

/// The header's "no expiry" sentinel: `expires_at` is a fixed `i64` slot.
const NO_EXPIRY: i64 = i64::MIN;

/// The number of bytes a `created_at ‖ event_id` key appends after the timestamp.
const EVENT_ID_LEN: usize = 32;

/// An invalid stored value, naming the database it was read from.
pub(crate) fn invalid(table: &'static str, message: String) -> StorageError {
    StorageError::InvalidRow {
        table,
        column: "value",
        value: message,
    }
}

/// The instant a row carries, truncated to the microsecond precision every PostgreSQL
/// `timestamp` column has, so a value written by either backend reads back the same.
pub(crate) fn micros(value: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp_micros(value.timestamp_micros()).unwrap_or(value)
}

/// An `i64` ordered by its bytes: the sign bit is flipped so a negative value sorts before
/// zero rather than after every positive one.
pub(crate) fn i64_key(value: i64) -> [u8; 8] {
    ((value as u64) ^ (1 << 63)).to_be_bytes()
}

/// The inverse of [`i64_key`].
pub(crate) fn i64_from_key(bytes: &[u8]) -> Result<i64, StorageError> {
    let raw = u64::from_be_bytes(fixed::<8>("events", bytes)?);
    Ok((raw ^ (1 << 63)) as i64)
}

/// An `i32` ordered by its bytes, sign-flipped for the same reason as [`i64_key`].
pub(crate) fn i32_key(value: i32) -> [u8; 4] {
    ((value as u32) ^ (1 << 31)).to_be_bytes()
}

/// The inverse of [`i32_key`].
pub(crate) fn i32_from_key(bytes: &[u8]) -> Result<i32, StorageError> {
    let raw = u32::from_be_bytes(fixed::<4>("events", bytes)?);
    Ok((raw ^ (1 << 31)) as i32)
}

fn fixed<const N: usize>(table: &'static str, bytes: &[u8]) -> Result<[u8; N], StorageError> {
    bytes
        .try_into()
        .map_err(|_| invalid(table, format!("{N} bytes expected, {} found", bytes.len())))
}

/// One event value's fixed header, decoded without touching the JSON body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EventHeader {
    pub deleted: bool,
    pub created_at: i64,
    pub kind: i32,
    pub expires_at: Option<i64>,
    pub pubkey: Pubkey,
}

/// Encodes the fixed header of an event value.
pub(crate) fn header_bytes(header: &EventHeader) -> [u8; EVENT_HEADER_LEN] {
    let mut bytes = [0u8; EVENT_HEADER_LEN];
    if header.deleted {
        bytes[0] = FLAG_DELETED;
    }
    bytes[1..9].copy_from_slice(&header.created_at.to_be_bytes());
    bytes[9..13].copy_from_slice(&header.kind.to_be_bytes());
    bytes[13..21].copy_from_slice(&header.expires_at.unwrap_or(NO_EXPIRY).to_be_bytes());
    bytes[21..53].copy_from_slice(header.pubkey.as_bytes());
    // bytes[53] is reserved and written as zero.
    bytes
}

/// Checks the format byte and returns the value's body (the version byte and header gone).
pub(crate) fn body<'a>(table: &'static str, value: &'a [u8]) -> Result<&'a [u8], StorageError> {
    check_version(table, value)?;
    let start = 1 + EVENT_HEADER_LEN;
    value
        .get(start..)
        .filter(|body| !body.is_empty())
        .ok_or_else(|| {
            invalid(
                table,
                format!("the header is truncated at {} bytes", value.len()),
            )
        })
}

/// The 32-byte event id an index key or a database value carries.
pub(crate) fn event_id_from(bytes: &[u8]) -> Result<EventId, StorageError> {
    Ok(EventId::from_byte_array(fixed::<32>("events", bytes)?))
}

/// The 32-byte pubkey an index key carries.
pub(crate) fn pubkey_from(bytes: &[u8]) -> Result<Pubkey, StorageError> {
    Ok(Pubkey::from_byte_array(fixed::<32>("events", bytes)?))
}

/// One key range as the borrowed pair heed's `range` accepts. An empty bound is
/// [`Bound::Unbounded`]: LMDB answers `MDB_BAD_VALSIZE` for a zero-length seek key, and the
/// created-at path uses the empty bound to mean "from the first key".
pub(crate) fn bounds<'a>(lower: &'a [u8], upper: &'a [u8]) -> (Bound<&'a [u8]>, Bound<&'a [u8]>) {
    let start = if lower.is_empty() {
        Bound::Unbounded
    } else {
        Bound::Included(lower)
    };
    let end = if upper.is_empty() {
        Bound::Unbounded
    } else {
        Bound::Included(upper)
    };
    (start, end)
}

/// One key range that resumes after `after`, exclusive, when a previous batch stopped there.
pub(crate) fn resume_bounds<'a>(
    after: Option<&'a [u8]>,
    lower: &'a [u8],
    upper: &'a [u8],
) -> (Bound<&'a [u8]>, Bound<&'a [u8]>) {
    let (start, end) = bounds(lower, upper);
    let start = match after {
        Some(after) => Bound::Excluded(after),
        None => start,
    };
    (start, end)
}

/// Decodes an event value's fixed header, without its JSON body.
pub(crate) fn event_header(table: &'static str, value: &[u8]) -> Result<EventHeader, StorageError> {
    check_version(table, value)?;
    let end = 1 + EVENT_HEADER_LEN;
    let header = value.get(1..end).ok_or_else(|| {
        invalid(
            table,
            format!("the header is truncated at {} bytes", value.len()),
        )
    })?;
    let expires_at = i64::from_be_bytes(fixed::<8>(table, &header[13..21])?);
    Ok(EventHeader {
        deleted: header[0] & FLAG_DELETED != 0,
        created_at: i64::from_be_bytes(fixed::<8>(table, &header[1..9])?),
        kind: i32::from_be_bytes(fixed::<4>(table, &header[9..13])?),
        expires_at: (expires_at != NO_EXPIRY).then_some(expires_at),
        pubkey: Pubkey::from_byte_array(fixed::<32>(table, &header[21..53])?),
    })
}

/// Rejects a value written by a different row format, and one too short to carry a version.
pub(crate) fn check_version(table: &'static str, value: &[u8]) -> Result<(), StorageError> {
    match value.split_first() {
        Some((version, _)) if *version == ROW_FORMAT_VERSION => Ok(()),
        Some((version, _)) => Err(invalid(
            table,
            format!("unsupported format version {version}"),
        )),
        None => Err(invalid(table, "the value is empty".to_owned())),
    }
}

/// `created_at ‖ event_id`.
pub(crate) fn created_at_key(created_at: i64, event_id: &EventId) -> Vec<u8> {
    let mut key = Vec::with_capacity(8 + EVENT_ID_LEN);
    key.extend_from_slice(&i64_key(created_at));
    key.extend_from_slice(event_id.as_bytes());
    key
}

/// `expires_at ‖ event_id` and `deleted_at ‖ event_id`, which have the same shape as a
/// `created_at` key.
pub(crate) fn time_key(value: i64, event_id: &EventId) -> Vec<u8> {
    created_at_key(value, event_id)
}

/// `pubkey ‖ kind ‖ created_at ‖ event_id`.
pub(crate) fn author_key(
    pubkey: &Pubkey,
    kind: i32,
    created_at: i64,
    event_id: &EventId,
) -> Vec<u8> {
    let mut key = Vec::with_capacity(32 + 4 + 8 + EVENT_ID_LEN);
    key.extend_from_slice(pubkey.as_bytes());
    key.extend_from_slice(&i32_key(kind));
    key.extend_from_slice(&i64_key(created_at));
    key.extend_from_slice(event_id.as_bytes());
    key
}

/// `pubkey ‖ kind ‖ dedup_len ‖ canonical JSON`, where `dedup_len` is the JSON's byte length.
// shortcut: the deduplication index uses `serde_json` text as its key, so `1` and `1.0` differ
// where `jsonb` would not; upgrade when a caller can pass a hand-built JSON number, which
// today's two callers cannot (spec Assumption 11).
pub(crate) fn replaceable_key(
    pubkey: &Pubkey,
    kind: i32,
    deduplication: &[serde_json::Value],
) -> Result<Vec<u8>, StorageError> {
    let json = serde_json::to_vec(deduplication).map_err(|error| StorageError::InvalidRow {
        table: "events",
        column: "event_deduplication",
        value: error.to_string(),
    })?;
    let length = u16::try_from(json.len()).map_err(|_| StorageError::InvalidRow {
        table: "events",
        column: "event_deduplication",
        value: "the deduplication value is longer than 65535 bytes".to_owned(),
    })?;
    let mut key = Vec::with_capacity(32 + 4 + 2 + json.len());
    key.extend_from_slice(pubkey.as_bytes());
    key.extend_from_slice(&i32_key(kind));
    key.extend_from_slice(&length.to_be_bytes());
    key.extend_from_slice(&json);
    Ok(key)
}

/// `tag_name ‖ 0x00 ‖ tag_value ‖ 0x00 ‖ created_at ‖ event_id`.
///
/// A name or value containing `0x00` is unrepresentable in the capture's `text` columns and
/// would make the separator ambiguous, so it is rejected rather than encoded.
pub(crate) fn tag_key(
    name: &str,
    value: &str,
    created_at: i64,
    event_id: &EventId,
) -> Result<Vec<u8>, StorageError> {
    if name.contains('\0') {
        return Err(StorageError::InvalidRow {
            table: "event_tags",
            column: "tag_name",
            value: name.to_owned(),
        });
    }
    if value.contains('\0') {
        return Err(StorageError::InvalidRow {
            table: "event_tags",
            column: "tag_value",
            value: value.to_owned(),
        });
    }
    let mut key = Vec::with_capacity(name.len() + value.len() + 2 + 8 + EVENT_ID_LEN);
    key.extend_from_slice(name.as_bytes());
    key.push(0);
    key.extend_from_slice(value.as_bytes());
    key.push(0);
    key.extend_from_slice(&i64_key(created_at));
    key.extend_from_slice(event_id.as_bytes());
    Ok(key)
}

/// The tag rows the capture's trigger writes: one per element whose name is exactly one
/// character and whose value is present and non-empty, and never beyond the second element.
pub(crate) fn tag_entries(record: &crate::repositories::EventRecord) -> Vec<(&str, &str)> {
    let mut entries = Vec::new();
    for tag in &record.event.tags {
        let (Some(name), Some(value)) = (tag.first(), tag.get(1)) else {
            continue;
        };
        if name.chars().count() == 1 && !value.is_empty() {
            entries.push((name.as_str(), value.as_str()));
        }
    }
    entries
}

/// Whether a kind is replaceable, exactly as the capture's conflict-target predicate says:
/// 0, 3, 41 and the two parameterized ranges.
pub(crate) fn replaceable_kind(kind: i32) -> bool {
    matches!(kind, 0 | 3 | 41)
        || (10_000..20_000).contains(&kind)
        || (30_000..40_000).contains(&kind)
}

/// Whether the lowercase hex rendering of `bytes` starts with `prefix`, case-sensitively,
/// exactly as `String.prototype.startsWith` compares the capture's ids and pubkeys.
pub(crate) fn hex_matches(bytes: &[u8], prefix: &str) -> bool {
    if prefix.len() > bytes.len() * 2 {
        return false;
    }
    prefix.bytes().enumerate().all(|(index, character)| {
        let byte = bytes[index / 2];
        let nibble = if index % 2 == 0 {
            byte >> 4
        } else {
            byte & 0x0f
        };
        let expected = match character {
            b'0'..=b'9' => character - b'0',
            b'a'..=b'f' => character - b'a' + 10,
            _ => return false,
        };
        nibble == expected
    })
}

/// Hex to bytes, mapping an invalid digit to zero exactly as the SQL composer does.
pub(crate) fn hex_bytes(value: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(value.len() / 2);
    let digits = value.as_bytes();
    let mut index = 0;
    while index + 1 < digits.len() {
        bytes.push((hex_digit(digits[index]) << 4) | hex_digit(digits[index + 1]));
        index += 2;
    }
    bytes
}

fn hex_digit(digit: u8) -> u8 {
    match digit {
        b'0'..=b'9' => digit - b'0',
        b'a'..=b'f' => digit - b'a' + 10,
        b'A'..=b'F' => digit - b'A' + 10,
        _ => 0,
    }
}

/// The inclusive key ranges one hex criterion family covers, over a 32-byte id or pubkey.
///
/// A 64-character criterion is one equality range; an even prefix compares its bytes; an odd
/// one compares the bytes of the nibble range `0` to `f`, as `sql.rs` composes it. `suffix` is
/// the number of bytes the index key carries after the 32-byte field.
pub(crate) fn hex_ranges(criteria: &[String], suffix: usize) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut ranges = Vec::with_capacity(criteria.len());
    for criterion in criteria {
        let (lower, mut upper) = match criterion.len() % 2 {
            1 => (
                hex_bytes(&format!("{criterion}0")),
                hex_bytes(&format!("{criterion}f")),
            ),
            _ => {
                let prefix = hex_bytes(criterion);
                (prefix.clone(), prefix)
            }
        };
        upper.extend(std::iter::repeat_n(0xff, suffix));
        ranges.push((lower, upper));
    }
    ranges
}

/// The inclusive key ranges one tag criterion covers: an exact value is the range from the
/// value's own separator, and a `#g` prefix is the range over the value's first bytes.
pub(crate) fn tag_ranges(name: &str, criteria: &[String]) -> Vec<(Vec<u8>, Vec<u8>)> {
    let is_geohash = name == "g";
    let mut ranges = Vec::with_capacity(criteria.len());
    for criterion in criteria {
        let mut head = Vec::with_capacity(name.len() + 1 + criterion.len());
        head.extend_from_slice(name.as_bytes());
        head.push(0);
        match criterion.strip_suffix('*').filter(|_| is_geohash) {
            Some(prefix) => {
                head.extend_from_slice(prefix.as_bytes());
                let mut upper = head.clone();
                upper.extend(std::iter::repeat_n(0xff, 64));
                ranges.push((head, upper));
            }
            None => {
                head.extend_from_slice(criterion.as_bytes());
                head.push(0);
                let mut upper = head.clone();
                upper.extend(std::iter::repeat_n(0xff, 8 + EVENT_ID_LEN));
                ranges.push((head, upper));
            }
        }
    }
    ranges
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    fn id(byte: u8) -> EventId {
        EventId::from_byte_array([byte; 32])
    }

    #[test]
    fn a_timestamp_key_sorts_numerically() {
        let low = created_at_key(-5, &id(1));
        let zero = created_at_key(0, &id(1));
        let high = created_at_key(1_700_000_000, &id(1));
        assert!(low < zero);
        assert!(zero < high);
        assert_eq!(i64_from_key(&high[..8]).unwrap(), 1_700_000_000);
        assert_eq!(i64_from_key(&low[..8]).unwrap(), -5);
    }

    #[test]
    fn a_kind_key_sorts_numerically() {
        assert!(i32_key(-1) < i32_key(0));
        assert!(i32_key(0) < i32_key(1));
        assert_eq!(i32_from_key(&i32_key(30_023)).unwrap(), 30_023);
    }

    #[test]
    fn an_even_prefix_is_one_range_and_an_odd_one_is_one_nibble_range() {
        let ranges = hex_ranges(&["abcd".to_owned(), "abcde".to_owned()], 40);
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].0, vec![0xab, 0xcd]);
        assert_eq!(ranges[0].1.len(), 2 + 40);
        assert_eq!(ranges[1].0, vec![0xab, 0xcd, 0xe0]);
        assert_eq!(ranges[1].1, {
            let mut high = vec![0xab, 0xcd, 0xef];
            high.extend(std::iter::repeat_n(0xff, 40));
            high
        });
    }

    #[test]
    fn a_geohash_criterion_is_a_prefix_range_and_another_tag_is_exact() {
        let geohash = tag_ranges("g", &["u4pru*".to_owned()]);
        assert_eq!(geohash[0].0, b"g\0u4pru".to_vec());
        let exact = tag_ranges("e", &["u4pru*".to_owned()]);
        assert_eq!(exact[0].0, b"e\0u4pru*\0".to_vec());
    }

    #[test]
    fn the_header_round_trips_without_its_body() {
        let header = EventHeader {
            deleted: true,
            created_at: 1_700_000_000,
            kind: 30_023,
            expires_at: Some(2_000_000_000),
            pubkey: Pubkey::from_byte_array([7; 32]),
        };
        let mut value = vec![ROW_FORMAT_VERSION];
        value.extend_from_slice(&header_bytes(&header));
        assert_eq!(event_header("events", &value).unwrap(), header);
    }

    #[test]
    fn an_unsupported_format_version_names_the_version() {
        let error = check_version("events", &[2, 0]).expect_err("version 2");
        match error {
            StorageError::InvalidRow { value, .. } => {
                assert_eq!(value, "unsupported format version 2");
            }
            other => panic!("expected InvalidRow, got {other:?}"),
        }
    }

    #[test]
    fn a_truncated_header_is_an_invalid_row() {
        let error = event_header("events", &[ROW_FORMAT_VERSION, 0]).expect_err("truncated");
        assert!(matches!(error, StorageError::InvalidRow { .. }));
    }

    #[test]
    fn a_tag_name_or_value_carrying_a_separator_is_rejected() {
        let error = tag_key("e", "a\0b", 0, &id(1)).expect_err("a separator in the value");
        assert!(matches!(
            error,
            StorageError::InvalidRow {
                column: "tag_value",
                ..
            }
        ));
        let error = tag_key("e\0", "ab", 0, &id(1)).expect_err("a separator in the name");
        assert!(matches!(
            error,
            StorageError::InvalidRow {
                column: "tag_name",
                ..
            }
        ));
    }

    #[test]
    fn only_the_trigger_s_tag_shape_is_indexed() {
        use nostream_core::Event;

        let event: Event = serde_json::from_value(serde_json::json!({
            "id": "0d684e8ec2431de586aa3cafbee2f6d308d19b28805e53deabcac3220e9136a5",
            "pubkey": "f43c1f9bff677b8f27b602725ea0ad51af221344f69a6b352a74991a4479bac3",
            "created_at": 1660407625i64,
            "kind": 1,
            "tags": [["e", "x", "y"], ["", "x"], ["e", ""], ["ab", "c"], ["p", "q"]],
            "content": "",
            "sig": "ab".repeat(64)
        }))
        .expect("a wire event");
        let record = crate::repositories::EventRecord::from_event(&event);
        assert_eq!(tag_entries(&record), vec![("e", "x"), ("p", "q")]);
    }

    #[test]
    fn the_replaceable_kind_set_matches_the_conflict_target() {
        for kind in [0, 3, 41, 10_000, 19_999, 30_000, 39_999] {
            assert!(replaceable_kind(kind), "{kind} is replaceable");
        }
        for kind in [1, 2, 4, 9_999, 20_000, 29_999, 40_000] {
            assert!(!replaceable_kind(kind), "{kind} is not replaceable");
        }
    }

    #[test]
    fn hex_prefixes_compare_nibbles_case_sensitively() {
        assert!(hex_matches(&[0xab, 0xcd], "abcd"));
        assert!(hex_matches(&[0xab, 0xcd], "abc"));
        assert!(!hex_matches(&[0xab, 0xcd], "ABC"));
        assert!(!hex_matches(&[0xab, 0xcd], "abce"));
        assert!(!hex_matches(&[0xab, 0xcd], "abcdef"));
    }
}
