//! The page contract `EventRepository::find_by_filters` states, over the real backend.
//!
//! A caller that must know whether a page was truncated compares the rows it received against
//! `min(limit, page_bound())`. That is sound only while the backend fills its page and never
//! exceeds it, in both directions — a backend that yields fewer rows than that while more exist
//! makes a false NIP-67 `finish` reach the wire, and one that yields more suppresses a hint it
//! could have proved.

#![cfg(feature = "lmdb")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::{collect, fixture, settings_from_fixture};
use nostream_core::{Event, EventId, Filter, Kind, Pubkey, Signature};
use nostream_storage::repositories::{EventRecord, EventRepository};
use nostream_storage::{LmdbBackend, MAX_PAGE_ROWS};

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

/// LMDB declares `MAX_PAGE_ROWS`, fills a page that asks for exactly that, and never exceeds it.
#[tokio::test]
async fn lmdb_declares_and_fills_the_page_bound() {
    let (_directory, backend) = open_store().await;
    assert_eq!(backend.page_bound(), MAX_PAGE_ROWS);

    let records: Vec<EventRecord> = (1..=MAX_PAGE_ROWS as i64 + 1)
        .map(|step| note(11, step))
        .collect();
    backend
        .create_many(&records)
        .await
        .expect("the store creates");

    let stored = filter(Kind(1));

    let full = collect(
        backend
            .find_by_filters(&[Filter {
                limit: Some(MAX_PAGE_ROWS + 1),
                ..stored.clone()
            }])
            .await
            .expect("a read"),
    )
    .await
    .expect("a read drains");
    assert_eq!(
        full.len() as u64,
        MAX_PAGE_ROWS,
        "a page asking for more than the bound gets the bound, not more"
    );

    let short = collect(
        backend
            .find_by_filters(&[Filter {
                limit: Some(3),
                ..stored
            }])
            .await
            .expect("a read"),
    )
    .await
    .expect("a read drains");
    assert_eq!(short.len(), 3, "a page asking for less is filled");
}

/// The filter the cases read through.
fn filter(kind: Kind) -> Filter {
    Filter {
        kinds: Some(vec![kind]),
        ..Filter::default()
    }
}
