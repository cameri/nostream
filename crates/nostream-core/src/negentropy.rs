//! NIP-77 set reconciliation, over the `negentropy` crate.
//!
//! The capture implements the protocol by hand (`src/utils/negentropy.ts:1-548`, a port of
//! `hoytech/negentropy` js/Negentropy.js). This module is a seam over the `negentropy`
//! crate 0.5.2 (MIT, rust-nostr), which speaks the same protocol version —
//! [`PROTOCOL_VERSION`] is `0x61`, the capture's `NEGENTROPY_PROTOCOL_VERSION`
//! (`src/utils/negentropy.ts:9`) — so the reference bytes in
//! `test/unit/utils/negentropy.spec.ts:239-263` are its oracle.
//!
//! Six of that suite's 44 cases cannot be reproduced against the crate, because the crate
//! makes faults unrepresentable rather than refusing them at run time; `tests/negentropy_parity.rs`
//! states each one and the behaviour that replaces it. What stands in for the issue's
//! "negentropy-range helpers NIP-77 needs" is exactly this: the range, bound, fingerprint
//! and reconcile engine the relay's NIP-77 session will drive.

use crate::constants::MAX_SAFE_INTEGER;
use crate::error::CoreError;
use crate::event::{Event, EventId};

pub use negentropy::{
    Bound, Error as NegentropyError, Id as NegentropyId, Item, Negentropy, NegentropyStorageBase,
    NegentropyStorageVector, PROTOCOL_VERSION,
};

/// Builds a sealed storage vector from `(created_at, id)` pairs.
///
/// A `created_at` that the capture's `insert` refuses — negative, or at the
/// `MAX_TIMESTAMP` sentinel (`src/utils/negentropy.ts:144-147`) — is an error here too.
/// Fractional timestamps cannot arrive: the argument is `i64`.
pub fn storage_from_items(
    items: impl IntoIterator<Item = (i64, EventId)>,
) -> Result<NegentropyStorageVector, CoreError> {
    let mut storage = NegentropyStorageVector::new();

    for (created_at, id) in items {
        if created_at < 0 || created_at as u64 >= MAX_SAFE_INTEGER {
            return Err(CoreError::InvalidNegentropyStorage(format!(
                "bad timestamp for added item: {created_at}"
            )));
        }

        storage
            .insert(
                created_at as u64,
                NegentropyId::from_byte_array(*id.as_bytes()),
            )
            .map_err(|error| CoreError::InvalidNegentropyStorage(error.to_string()))?;
    }

    storage
        .seal()
        .map_err(|error| CoreError::InvalidNegentropyStorage(error.to_string()))?;

    Ok(storage)
}

/// [`storage_from_items`] over events, keyed by their id and `created_at`.
pub fn storage_from_events<'a>(
    events: impl IntoIterator<Item = &'a Event>,
) -> Result<NegentropyStorageVector, CoreError> {
    storage_from_items(events.into_iter().map(|event| (event.created_at, event.id)))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::event::{Kind, Pubkey, Signature};

    fn event(created_at: i64, id: [u8; 32]) -> Event {
        Event {
            id: EventId::from_byte_array(id),
            pubkey: Pubkey::from_byte_array([3; 32]),
            created_at,
            kind: Kind::TEXT_NOTE,
            tags: Vec::new(),
            content: String::new(),
            sig: Signature::from_byte_array([0; 64]),
        }
    }

    #[test]
    fn storage_from_events_seals_every_item() {
        let events = [event(10, [1; 32]), event(10, [2; 32]), event(11, [3; 32])];

        let storage = storage_from_events(&events).unwrap();

        assert_eq!(storage.size().unwrap(), 3);
    }

    #[test]
    fn storage_from_items_rejects_a_negative_timestamp() {
        let error = storage_from_items([(-1, EventId::from_byte_array([1; 32]))]).unwrap_err();

        assert!(error.to_string().contains("bad timestamp"), "{error}");
    }

    #[test]
    fn storage_from_items_rejects_the_max_timestamp_sentinel() {
        let sentinel = i64::try_from(MAX_SAFE_INTEGER).unwrap();

        assert!(storage_from_items([(sentinel, EventId::from_byte_array([1; 32]))]).is_err());
    }

    #[test]
    fn storage_reports_the_protocol_version_the_capture_uses() {
        assert_eq!(PROTOCOL_VERSION, 0x61);
    }
}
