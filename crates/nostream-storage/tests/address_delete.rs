//! `delete_by_address`: the NIP-09 `a`-tag delete, over the real store.
//!
//! The seam resolves the address and soft-deletes it in one operation, walking the author's kind
//! index rather than a read page, so neither the page bound nor the gap between a read and a
//! delete can leave a named row alive.

#![cfg(feature = "lmdb")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::{Repos, collect, fixture, settings_from_fixture};
use nostream_core::{Event, EventId, Filter, Kind, Pubkey, Signature};
use nostream_storage::LmdbBackend;
use nostream_storage::repositories::{EventRecord, EventRepository, NewReport, ReportType};

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

/// A kind-30023 row under the address `30023:<pubkey>:<d>`, by the key `secret`.
fn addressable(secret: u8, d: &str, created_at: i64) -> EventRecord {
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
    EventRecord::from_event(&event)
}

/// 501 addressable rows of one author, so the target sits past the backend's page bound: a
/// read-then-delete seam could not reach it.
#[tokio::test]
async fn delete_by_address_reaches_a_row_past_the_page_bound() {
    let (_directory, backend) = open_store().await;
    let mut target = None;

    for index in 0..501u64 {
        let record = addressable(7, &format!("post-{index}"), 1_700_000_000 + index as i64);
        backend.create(&record).await.expect("the store creates");

        if index == 500 {
            target = Some(record);
        }
    }

    let target = target.expect("the five hundred and first row");
    let filter = Filter {
        authors: Some(vec![target.event.pubkey.to_string()]),
        ..Default::default()
    };

    // A streamed read is what a read-then-delete seam would have used, and it stops at the
    // backend's page, so the five hundred and first row is not in it.
    let served = collect(
        backend
            .find_by_filters(std::slice::from_ref(&filter))
            .await
            .expect("a read"),
    )
    .await
    .expect("a read drains")
    .len();
    assert!(
        served < 501,
        "the read page is bounded ({served} of 501), which is why the delete may not go through it"
    );

    let deleted = backend
        .delete_by_address(&target.event.pubkey, Kind(30_023), "post-500", i64::MAX)
        .await
        .expect("the store deletes");

    assert_eq!(deleted, 1);
    assert_eq!(
        backend
            .count_by_filters(std::slice::from_ref(&filter))
            .await
            .expect("a read after the delete"),
        500,
        "the row named by the address is the one gone"
    );
}

/// A row NIP-56 withholds from reads is still a row the author's deletion request names: the
/// report gate lives on the read path, and the delete walks the author's index instead.
#[tokio::test]
async fn delete_by_address_reaches_a_reported_row() {
    let (_directory, backend) = open_store().await;
    let target = addressable(7, "post-1", 1_700_000_000);
    backend.create(&target).await.expect("the store creates");

    let repos = Repos::all(&backend);
    repos
        .reports
        .create(&NewReport {
            event_id: EventId::from_byte_array([9; 32]),
            reporter_pubkey: Pubkey::from_byte_array([8; 32]),
            reported_pubkey: Some(target.event.pubkey),
            reported_event_id: Some(target.event.id),
            report_type: ReportType::Spam,
            weight: 1.0,
            actionable: true,
        })
        .await
        .expect("the report stores");

    let filter = Filter {
        authors: Some(vec![target.event.pubkey.to_string()]),
        ..Default::default()
    };
    assert_eq!(
        backend
            .count_by_filters(std::slice::from_ref(&filter))
            .await
            .expect("a read"),
        0,
        "the read path withholds the reported row"
    );

    let deleted = backend
        .delete_by_address(&target.event.pubkey, Kind(30_023), "post-1", i64::MAX)
        .await
        .expect("the store deletes");

    assert_eq!(deleted, 1, "the delete reaches the row the read cannot");
}

/// The request's own `created_at` is the authorisation window, so the comparison is inside the
/// delete: a row newer than the request survives, and one no newer than it goes. Both rows sit
/// under the same author and kind, one address apart, so only the bound decides.
#[tokio::test]
async fn delete_by_address_keeps_a_row_newer_than_the_request() {
    let (_directory, backend) = open_store().await;
    let author = addressable(7, "kept", 1_010);
    let at_the_bound = addressable(7, "gone", 1_000);
    backend.create(&author).await.expect("the store creates");
    backend
        .create(&at_the_bound)
        .await
        .expect("the store creates");

    assert_eq!(
        backend
            .delete_by_address(&author.event.pubkey, Kind(30_023), "kept", 1_000)
            .await
            .expect("the store deletes"),
        0,
        "a replacement newer than the request is not its to delete"
    );
    assert_eq!(
        backend
            .delete_by_address(&at_the_bound.event.pubkey, Kind(30_023), "gone", 1_000)
            .await
            .expect("the store deletes"),
        1,
        "a row at exactly the request's created_at is deleted"
    );

    assert_eq!(
        backend
            .count_by_filters(&[Filter {
                authors: Some(vec![author.event.pubkey.to_string()]),
                ..Default::default()
            }])
            .await
            .expect("a read"),
        1,
        "only the newer row is left"
    );
}
