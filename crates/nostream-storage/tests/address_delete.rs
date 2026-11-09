//! `delete_by_addresses`: the NIP-09 `a`-tag delete, over the real store.
//!
//! The seam resolves each address through the `replaceable` point index and soft-deletes the
//! whole batch in one write transaction, so neither the page bound nor the gap between a lookup
//! and a delete can leave a named row alive — and an address costs one lookup rather than a walk
//! of the author's kind.

#![cfg(feature = "lmdb")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::{Repos, fixture, settings_from_fixture};
use nostream_core::{Event, EventId, Filter, Kind, Pubkey, Signature};
use nostream_storage::LmdbBackend;
use nostream_storage::repositories::{
    EventRecord, EventRepository, NewReport, ReportType, collect_records,
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

/// A kind-30023 row under the address `30023:<pubkey>:<d>`, by the key `secret`, carrying the
/// deduplication value the strategy writes.
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

    EventRecord::from_event(&event).with_deduplication(vec![serde_json::Value::String(
        event.d_tag_value().to_owned(),
    )])
}

/// One address, as the trait takes it.
fn address(d: &str) -> (Kind, String) {
    (Kind(30_023), d.to_owned())
}

/// How many live rows the store serves this author.
async fn live_rows(backend: &LmdbBackend, pubkey: &Pubkey) -> u64 {
    backend
        .count_by_filters(&[Filter {
            authors: Some(vec![pubkey.to_string()]),
            ..Default::default()
        }])
        .await
        .expect("a read")
}

/// 501 addressable rows of one author, so the target is far past the backend's page bound: a
/// read-then-delete seam could not reach it, and a walk of the kind would cost 501 decodes.
#[tokio::test]
async fn delete_by_addresses_reaches_a_row_past_the_page_bound() {
    let (_directory, backend) = open_store().await;
    let mut target = None;

    for index in 0..501u64 {
        let record = addressable(7, &format!("post-{index}"), 1_700_000_000 + index as i64);
        backend.upsert(&record).await.expect("the store upserts");

        if index == 500 {
            target = Some(record);
        }
    }

    let target = target.expect("the five hundred and first row");
    let filter = Filter {
        authors: Some(vec![target.event.pubkey.to_string()]),
        ..Default::default()
    };

    let served = collect_records(
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
        .delete_by_addresses(&target.event.pubkey, &[address("post-500")], i64::MAX)
        .await
        .expect("the store deletes");

    assert_eq!(deleted, 1);
    assert_eq!(
        live_rows(&backend, &target.event.pubkey).await,
        500,
        "the row named by the address is the one gone"
    );
}

/// One call is one transaction for the whole batch, and an address that names nothing costs
/// nothing: three addresses and one miss delete three rows, and an empty batch is zero.
#[tokio::test]
async fn delete_by_addresses_deletes_the_whole_batch() {
    let (_directory, backend) = open_store().await;

    let mut author = None;

    for d in ["post-1", "post-2", "post-3"] {
        let record = addressable(7, d, 1_700_000_000);
        author = Some(record.event.pubkey);
        backend.upsert(&record).await.expect("the store upserts");
    }

    let author = author.expect("one row");

    assert_eq!(
        backend
            .delete_by_addresses(
                &author,
                &[address("post-1"), address("post-2"), address("missing")],
                i64::MAX,
            )
            .await
            .expect("the store deletes"),
        2
    );
    assert_eq!(
        backend
            .delete_by_addresses(&author, &[], i64::MAX)
            .await
            .expect("the store deletes"),
        0,
        "an empty batch is not an error"
    );
    assert_eq!(live_rows(&backend, &author).await, 1);
}

/// A row NIP-56 withholds from reads is still a row the author's deletion request names: the
/// report gate lives on the read path, and the delete walks the address index instead.
#[tokio::test]
async fn delete_by_addresses_reaches_a_reported_row() {
    let (_directory, backend) = open_store().await;
    let target = addressable(7, "post-1", 1_700_000_000);
    backend.upsert(&target).await.expect("the store upserts");

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

    assert_eq!(
        live_rows(&backend, &target.event.pubkey).await,
        0,
        "the read path withholds the reported row"
    );

    let deleted = backend
        .delete_by_addresses(&target.event.pubkey, &[address("post-1")], i64::MAX)
        .await
        .expect("the store deletes");

    assert_eq!(deleted, 1, "the delete reaches the row the read cannot");
}

/// The request's own `created_at` is the authorisation window, so the comparison is inside the
/// delete: a row newer than the request survives, and one no newer than it goes. Both rows sit
/// under the same author and kind, one address apart, so only the bound decides.
#[tokio::test]
async fn delete_by_addresses_keeps_a_row_newer_than_the_request() {
    let (_directory, backend) = open_store().await;
    let author = addressable(7, "kept", 1_010);
    let at_the_bound = addressable(7, "gone", 1_000);
    backend.upsert(&author).await.expect("the store upserts");
    backend
        .upsert(&at_the_bound)
        .await
        .expect("the store upserts");

    let deleted = backend
        .delete_by_addresses(
            &author.event.pubkey,
            &[address("kept"), address("gone")],
            1_000,
        )
        .await
        .expect("the store deletes");

    assert_eq!(
        deleted, 1,
        "the newer row is not the request's to delete, the other is"
    );
    assert_eq!(
        live_rows(&backend, &author.event.pubkey).await,
        1,
        "only the newer row is left"
    );
}

/// The address's `d` is [`nostream_core::Event::d_tag_value`], the value every writer of the
/// deduplication column uses: the **first** `d` tag. A row carrying two `d` tags is therefore
/// addressable as its first and not as its second, on this backend and on Postgres, whose
/// predicate matches the column the same function filled.
#[tokio::test]
async fn delete_by_addresses_uses_the_first_d_tag() {
    let (_directory, backend) = open_store().await;
    let mut event = Event {
        id: EventId::from_byte_array([0; 32]),
        pubkey: Pubkey::from_byte_array([0; 32]),
        created_at: 1_700_000_000,
        kind: Kind(30_023),
        tags: vec![
            vec!["d".to_owned(), "a".to_owned()],
            vec!["d".to_owned(), "b".to_owned()],
        ],
        content: "two d tags".to_owned(),
        sig: Signature::from_byte_array([0; 64]),
    };
    nostream_core::crypto::sign_event(&[7; 32], &mut event).expect("the event signs");
    let record =
        EventRecord::from_event(&event).with_deduplication(vec![serde_json::Value::String(
            event.d_tag_value().to_owned(),
        )]);
    backend.upsert(&record).await.expect("the store upserts");

    assert_eq!(
        backend
            .delete_by_addresses(&event.pubkey, &[address("b")], i64::MAX)
            .await
            .expect("the store deletes"),
        0,
        "the second d tag is not the address"
    );
    assert_eq!(
        backend
            .delete_by_addresses(&event.pubkey, &[address("a")], i64::MAX)
            .await
            .expect("the store deletes"),
        1,
        "the first d tag is"
    );
}

/// A row written through `create` carries no deduplication value — the capture's `INSERT` omits
/// the column — so it has no address pointer and neither backend's address delete can name it.
/// No production path creates an addressable kind (the relay and the importer both upsert), so
/// this pins the shape rather than a live defect: it is why the tests here seed with `upsert`.
#[tokio::test]
async fn a_row_written_through_create_has_no_address_pointer() {
    let (_directory, backend) = open_store().await;
    let target = addressable(7, "post-1", 1_700_000_000);
    backend.create(&target).await.expect("the store creates");

    assert_eq!(
        backend
            .delete_by_addresses(&target.event.pubkey, &[address("post-1")], i64::MAX)
            .await
            .expect("the store deletes"),
        0
    );
    assert_eq!(live_rows(&backend, &target.event.pubkey).await, 1);
}
