//! A tag criterion that is the empty string, over the real store.
//!
//! `Filter::matches` accepts a tag stored as `["d", ""]` — the criterion and the value compare
//! equal — while LMDB's `tags` index holds no entry for an empty value
//! (`encoding.rs:387`), so the read selects nothing. That disagreement is what
//! `EventRepository::empty_tag_rule` declares as `IndexesNoEmptyValue`, and it is why the relay
//! withholds `finish` for such a filter: the stored article matches the subscription and would
//! never be sent.

#![cfg(feature = "lmdb")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::BTreeMap;
use std::sync::Arc;

use common::{fixture, settings_from_fixture};
use nostream_core::{Event, EventId, Filter, Kind, Pubkey, Signature};
use nostream_storage::LmdbBackend;
use nostream_storage::repositories::{EmptyTagRule, EventRecord, EventRepository, collect_records};

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

/// A signed kind-30023 row carrying one `d` tag, with the deduplication value the addressable
/// write paths store so two values are two rows rather than one replacement.
fn article(secret: u8, d: &str, created_at: i64) -> Event {
    let mut event = Event {
        id: EventId::from_byte_array([0; 32]),
        pubkey: Pubkey::from_byte_array([0; 32]),
        created_at,
        kind: Kind(30_023),
        tags: vec![vec!["d".to_owned(), d.to_owned()]],
        content: format!("{secret}-{d}-{created_at}"),
        sig: Signature::from_byte_array([0; 64]),
    };
    nostream_core::crypto::sign_event(&[secret; 32], &mut event).expect("the event signs");

    event
}

/// The row to write for `event`.
fn record(event: &Event) -> EventRecord {
    EventRecord::from_event(event).with_deduplication(vec![serde_json::Value::String(
        event.d_tag_value().to_owned(),
    )])
}

/// One tag family, as `Filter` takes it.
fn tag_query(criterion: &str) -> Filter {
    Filter {
        tags: BTreeMap::from([("#d".to_owned(), vec![criterion.to_owned()])]),
        ..Default::default()
    }
}

/// The fact `EventRepository::empty_tag_rule` claims: the index cannot answer a criterion that is
/// the empty string, even over a row that carries one, while the relay's matcher accepts that
/// row. The second read is the control — an ordinary `#d` criterion still selects its row — so
/// the empty page is the criterion's and not a broken tag path.
#[tokio::test]
async fn an_empty_tag_value_is_not_selectable_through_the_index() {
    let (_directory, backend) = open_store().await;

    let empty = article(7, "", 1_700_000_000);
    assert!(
        tag_query("").matches(&empty),
        "the matcher accepts a [\"d\", \"\"] tag"
    );

    backend
        .upsert(&record(&empty))
        .await
        .expect("the store upserts");
    let named_row = article(7, "post-1", 1_700_000_001);
    backend
        .upsert(&record(&named_row))
        .await
        .expect("the store upserts");

    assert_eq!(
        backend.empty_tag_rule(),
        EmptyTagRule::IndexesNoEmptyValue,
        "the backend declares the rule this test measures"
    );

    let selected = collect_records(
        backend
            .find_by_filters(&[tag_query("")])
            .await
            .expect("a read"),
    )
    .await
    .expect("the stream");

    assert!(
        selected.is_empty(),
        "the tag index holds no empty value, so the criterion selects nothing: {} row(s)",
        selected.len()
    );

    let named = collect_records(
        backend
            .find_by_filters(&[tag_query("post-1")])
            .await
            .expect("a read"),
    )
    .await
    .expect("the stream");

    assert_eq!(named.len(), 1, "an ordinary `#d` criterion still selects");
    assert_eq!(named[0].event.id, named_row.id);
}
