//! The key codecs both backends and the migration seam share.
//!
//! A key's byte order *is* the sort order LMDB and PostgreSQL both rely on, so an arithmetic
//! slip here is not a compile error and not a visible wrong value: it is a cursor that seeks to
//! the wrong place, or a checksum that disagrees after a full copy. These lived in
//! `lmdb::encoding` and were restated in `migration` and `postgres::migration`, each with a
//! comment saying it had to compile without the other driver. One feature-free home removes the
//! restatement and the drift it invited; `lmdb::encoding` re-exports these so its callers are
//! unchanged.

use chrono::{DateTime, Utc};

/// An `i32` ordered by its bytes, with the sign bit flipped so a negative value sorts before
/// zero rather than after every positive one.
pub(crate) fn i32_key(value: i32) -> [u8; 4] {
    ((value as u32) ^ (1 << 31)).to_be_bytes()
}

/// The inverse of [`i32_key`], and `None` when the bytes are not four long. The caller names the
/// table in its own error, so the message an operator sees stays the one that backend wrote.
pub(crate) fn i32_from_key(bytes: &[u8]) -> Option<i32> {
    let raw = u32::from_be_bytes(bytes.try_into().ok()?);
    Some((raw ^ (1 << 31)) as i32)
}

/// The instant a row carries, truncated to the microsecond precision every PostgreSQL
/// `timestamp` column has, so a value written by either backend reads back the same.
pub(crate) fn micros(value: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp_micros(value.timestamp_micros()).unwrap_or(value)
}
