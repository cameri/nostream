//! `StreamedEvent::Vanished`: a page slot the store selected and could not read.
//!
//! `find_by_filters` fixes its page first — `ValuesStream::new` takes the page the read
//! collected — and then reads the values in batches of `STREAM_BATCH_ITEMS`, one read
//! transaction per batch. A key removed between the page and its batch therefore has a slot
//! with no row, and the stream reports that slot instead of skipping it: a silent skip is a
//! short page, which is what the relay reads as a complete result.

#![cfg(feature = "lmdb")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use chrono::Utc;
use common::{fixture, settings_from_fixture};
use nostream_core::{Event, EventId, Filter, Kind, Pubkey, Signature};
use nostream_storage::LmdbBackend;
use nostream_storage::repositories::{
    EventRecord, EventRepository, EventRetentionOptions, StreamedEvent,
};

/// A store on a temporary directory with the fixture's settings gates.
async fn open_store() -> (tempfile::TempDir, LmdbBackend) {
    let fixture = fixture();
    let directory = tempfile::tempdir().expect("tempdir");
    let backend = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens")
        .with_settings(Arc::new(settings_from_fixture(&fixture)));

    (directory, backend)
}

/// A signed kind-1 note by the key `secret`, at `created_at`.
fn note(secret: u8, created_at: i64) -> EventRecord {
    let mut event = Event {
        id: EventId::from_byte_array([0; 32]),
        pubkey: Pubkey::from_byte_array([0; 32]),
        created_at,
        kind: Kind(1),
        tags: Vec::new(),
        content: format!("{secret}-{created_at}"),
        sig: Signature::from_byte_array([0; 64]),
    };
    nostream_core::crypto::sign_event(&[secret; 32], &mut event).expect("the event signs");
    EventRecord::from_event(&event)
}

/// A key the page selected and a later read cannot find is reported where it sat in the page,
/// and every surviving row still arrives in the page's order.
///
/// The ordering is guaranteed rather than hoped for: `find_by_filters` collects the page inside
/// its own read (`lmdb/mod.rs` calls `events::page`), and `ValuesStream` does not read a value
/// until it is polled, in batches of 256 with one read transaction each. So a delete that
/// happens after `find_by_filters` returned lands between the page and every batch, and the
/// target sits at index 270 — past the first batch — so the case proved is the one the review
/// named rather than a deletion inside batch one.
#[tokio::test]
async fn a_key_removed_before_its_batch_is_read_yields_vanished_in_its_place() {
    let (_directory, backend) = open_store().await;

    // Recent `created_at`s, so the retention pass below takes the target because it is deleted
    // and not because every row is past the age limit. Distinct values, so the page's order is
    // the fixture's order.
    let base = Utc::now().timestamp() - 301;
    let records: Vec<EventRecord> = (0..300i64).map(|index| note(7, base + index)).collect();
    backend
        .create_many(&records)
        .await
        .expect("the events store");

    let filter = Filter {
        kinds: Some(vec![Kind(1)]),
        ..Filter::default()
    };
    let stream = backend
        .find_by_filters(std::slice::from_ref(&filter))
        .await
        .expect("a read");

    // A soft delete alone keeps the key; the retention pass is what removes a soft-deleted row,
    // which is one of the two ways LMDB drops a key (the other is a replacement's hard delete).
    let target = records[270].clone();
    assert_eq!(
        backend
            .delete_by_pubkey_and_ids(&target.event.pubkey, &[target.event.id])
            .await
            .expect("the row soft-deletes"),
        1
    );
    let purged = backend
        .delete_expired_and_retained(&EventRetentionOptions {
            max_days: Some(1),
            ..EventRetentionOptions::default()
        })
        .await
        .expect("the retention pass runs");
    assert_eq!(purged.deleted, 1, "the deleted row is hard-deleted");
    assert_eq!(
        purged.retained, 0,
        "no row is over the age limit, so the target is the only candidate"
    );

    let items = common::collect(stream).await.expect("the read drains");

    assert_eq!(
        items.len(),
        records.len(),
        "every selected slot is yielded, the vanished one included"
    );
    assert_eq!(
        items[270],
        StreamedEvent::Vanished,
        "the removed key is the slot that vanished"
    );
    assert_eq!(
        items
            .iter()
            .filter(|item| **item == StreamedEvent::Vanished)
            .count(),
        1,
        "no other slot lost its row"
    );

    let yielded: Vec<EventId> = items
        .iter()
        .filter_map(|item| match item {
            StreamedEvent::Record(record) => Some(record.event.id),
            StreamedEvent::Vanished => None,
        })
        .collect();
    let expected: Vec<EventId> = records
        .iter()
        .map(|record| record.event.id)
        .filter(|id| *id != target.event.id)
        .collect();

    assert_eq!(yielded, expected, "every survivor, in the page's order");
}
