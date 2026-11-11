//! Behavioural parity for the embedded backend: replays `tests/fixtures/repository-parity.json`
//! through `LmdbBackend` and compares every result with the TypeScript implementation's
//! recording, then covers the cases the replay cannot reach.
//!
//! No database and no network: the store is opened on a `tempfile::TempDir`. Every entry the
//! seam can run is replayed, and the list of the ones it cannot is asserted entry by entry, so
//! an exclusion can only grow by editing `EXCLUDED`, which the diff shows.

#![cfg(feature = "lmdb")]
// This integration-test target may unwrap: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};

use common::{Repos, fixture, settings_from_fixture};
use heed::Database;
use heed::types::Bytes;
use nostream_config::Settings;
use nostream_core::{Event, EventId, Filter, Kind, Pubkey, Signature};
use nostream_storage::LmdbBackend;
use nostream_storage::StorageError;
use nostream_storage::lmdb::{SEARCH_INDEX_DB, SEARCH_INDEX_MARKER, SEARCH_INDEX_VERSION};
use nostream_storage::repositories::{
    CreateInviteCodeOptions, DeliveryLogFilters, DvmJobStatus, EventRecord, EventRepository,
    EventRetentionOptions, FieldUpdate, InviteCodeRepository, Invoice, InvoiceRepository,
    InvoiceStatus, InvoiceUnit, NewDeliveryLogEntry, NewReport, Nip05Verification,
    NotificationDeliveryLogRepository, NotificationDeliveryStatus, NotificationOutboxRepository,
    NotificationTargetType, ReconciliationItem, ReportType, SearchRule, UserRepository,
    collect_records,
};

mod common;

/// The entries this arm cannot replay, fixed by index: 48 and 50 are `user.tos_accepted_at` (raw
/// SQL, no seam form), and 112 and 115 are the two `transaction` groups the capture rolled back —
/// a seam with no rollback cannot reproduce them.
/// The two groups it committed (111, 117) are replayed: their nested ops in order leave exactly
/// the state the commit left, which is why entries after 111 observe its rows.
///
/// Entry 21 — the one filter carrying `search` — is replayed now: the LMDB store answers NIP-50
/// from its own term index (`lmdb/search.rs`), which reproduces the capture's token predicate and
/// its recorded order on this corpus, so the exclusion has nothing left to stand on.
// shortcut: four fixture entries are excluded by index and the count is a constant; upgrade
// when the capture gains an entry, which fails the count assertion and forces this list to be
// re-derived rather than quietly skipped.
const EXCLUDED: [usize; 4] = [48, 50, 112, 115];

/// The entries that are replayed; `EXCLUDED.len() + REPLAYED` is the fixture's entry count.
const REPLAYED: usize = 114;

/// The exclusion list as the marker line prints it.
const EXCLUDED_MARKER: &str = "48,50,112,115";

/// Replays a transaction group the capture committed. The group's comparison is the aggregate
/// `{failed: false, results: [...]}`, and running its nested ops in order through the seam
/// produces exactly that shape and leaves the state the commit left. A group the capture rolled
/// back needs rollback, which this seam has no form for, and is listed in `EXCLUDED` instead.
async fn run_committed_transaction(
    backend: &LmdbBackend,
    op: &Value,
    refs: &mut HashMap<String, String>,
) -> Value {
    let mut results = Vec::new();
    for nested in op["request"]["ops"].as_array().expect("transaction ops") {
        let name = nested["op"].as_str().expect("an op name");
        let result = common::run_op(Repos::all(backend), nested, refs)
            .await
            .unwrap_or_else(|error| panic!("a committed transaction's {name} failed: {error}"));
        results.push(result);
    }
    json!({ "failed": false, "results": results })
}

/// One store on a temporary directory, with the fixture's settings gates.
async fn open_store() -> (tempfile::TempDir, LmdbBackend) {
    let fixture = fixture();
    let directory = tempfile::tempdir().expect("tempdir");
    let backend = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens")
        .with_settings(Arc::new(settings_from_fixture(&fixture)));
    (directory, backend)
}

/// A signed event of the given kind and creation time, by the key `secret`.
fn event(secret: u8, kind: u64, created_at: i64) -> EventRecord {
    let mut event = Event {
        id: EventId::from_byte_array([0; 32]),
        pubkey: Pubkey::from_byte_array([0; 32]),
        created_at,
        kind: Kind(kind),
        tags: Vec::new(),
        content: format!("{secret}-{created_at}"),
        sig: Signature::from_byte_array([0; 64]),
    };
    nostream_core::crypto::sign_event(&[secret; 32], &mut event).expect("the event signs");
    EventRecord::from_event(&event)
}

/// A signed event of the given kind and creation time, carrying `content`.
fn event_with_content(secret: u8, kind: u64, created_at: i64, content: &str) -> EventRecord {
    event_with_tags(secret, kind, created_at, content, Vec::new())
}

/// [`event_with_content`], carrying `tags`.
fn event_with_tags(
    secret: u8,
    kind: u64,
    created_at: i64,
    content: &str,
    tags: Vec<Vec<String>>,
) -> EventRecord {
    let mut event = Event {
        id: EventId::from_byte_array([0; 32]),
        pubkey: Pubkey::from_byte_array([0; 32]),
        created_at,
        kind: Kind(kind),
        tags,
        content: content.to_owned(),
        sig: Signature::from_byte_array([0; 64]),
    };
    nostream_core::crypto::sign_event(&[secret; 32], &mut event).expect("the event signs");
    EventRecord::from_event(&event)
}

/// The filter a search test sends.
fn search(query: &str) -> Filter {
    Filter {
        search: Some(query.to_owned()),
        ..Filter::default()
    }
}

/// The ids of the records a read returned, in the order it returned them.
fn ids_of(records: &[EventRecord]) -> Vec<EventId> {
    records.iter().map(|record| record.event.id).collect()
}

/// One store on a temporary directory, with `settings` as its gates.
async fn open_with(settings: Settings) -> (tempfile::TempDir, LmdbBackend) {
    let directory = tempfile::tempdir().expect("tempdir");
    let backend = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens")
        .with_settings(Arc::new(settings));
    (directory, backend)
}

/// The fixture's settings with one override replaced.
fn settings_with(path: &str, value: Value) -> Settings {
    let mut fixture = fixture();
    fixture["settings"]["overrides"]
        .as_object_mut()
        .expect("the fixture's overrides are an object")
        .insert(path.to_owned(), value);
    settings_from_fixture(&fixture)
}

/// The records one filter's page returns, in the page's order.
async fn rows_of(backend: &LmdbBackend, filter: &Filter) -> Vec<EventRecord> {
    collect_records(
        backend
            .find_by_filters(std::slice::from_ref(filter))
            .await
            .expect("the page"),
    )
    .await
    .expect("the stream")
}

/// The term index and the `meta` database, opened by name: `Databases` is crate-private.
fn named_databases(
    env: &heed::Env,
    rtxn: &heed::RoTxn<'_>,
) -> (Database<Bytes, Bytes>, Database<Bytes, Bytes>) {
    let index = env
        .open_database::<Bytes, Bytes>(rtxn, Some(SEARCH_INDEX_DB))
        .expect("the index opens")
        .expect("the index database exists");
    let meta = env
        .open_database::<Bytes, Bytes>(rtxn, Some("meta"))
        .expect("meta opens")
        .expect("the meta database exists");
    (index, meta)
}

/// How many `events_by_term` keys begin with `term`.
fn index_keys(backend: &LmdbBackend, term: &str) -> usize {
    let env = backend.env();
    let rtxn = env.read_txn().expect("a read transaction");
    let (index, _) = named_databases(env, &rtxn);
    index
        .prefix_iter(&rtxn, term.as_bytes())
        .expect("the index reads")
        .count()
}

/// The ids a page returned, ascending, so a caller can compare a set before it compares an
/// order.
fn sorted_ids(records: &[EventRecord]) -> Vec<EventId> {
    let mut ids = ids_of(records);
    ids.sort();
    ids
}

/// The set `page` returned, and that it is in ascending `event_id` order.
fn assert_set_in_id_order(page: &[EventRecord], expected: &[&EventRecord], what: &str) {
    let mut wanted: Vec<EventId> = expected.iter().map(|record| record.event.id).collect();
    wanted.sort();
    assert_eq!(sorted_ids(page), wanted, "{what}: the set");
    assert_eq!(ids_of(page), sorted_ids(page), "{what}: ascending event_id");
}

fn one_entry(outbox_id: Option<String>) -> NewDeliveryLogEntry {
    NewDeliveryLogEntry {
        outbox_id,
        event_type: "note.created".to_owned(),
        target_id: "https://example.test/hook".to_owned(),
        target_type: NotificationTargetType::Http,
        status: NotificationDeliveryStatus::Success,
        attempt_number: 1,
        error_snippet: None,
    }
}

/// `8-4-4-4-12`, all lowercase hex, version 4, variant 1.
fn assert_uuid_v4(value: &str) {
    let groups: Vec<&str> = value.split('-').collect();
    let lengths: Vec<usize> = groups.iter().map(|group| group.len()).collect();
    assert_eq!(
        lengths,
        vec![8, 4, 4, 4, 12],
        "{value} is hyphenated 8-4-4-4-12"
    );
    assert!(
        groups.iter().all(|group| group
            .chars()
            .all(|character| character.is_ascii_digit() || matches!(character, 'a'..='f'))),
        "{value} is lowercase hex"
    );
    assert_eq!(groups[2].as_bytes()[0], b'4', "{value} is version 4");
    assert!(
        matches!(groups[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'),
        "{value} carries the RFC 4122 variant"
    );
}

#[tokio::test]
async fn the_typescript_script_replays_with_an_empty_diff() {
    let fixture = fixture();
    let script = fixture["script"].as_array().expect("script");
    assert_eq!(
        script.len(),
        REPLAYED + EXCLUDED.len(),
        "the fixture's entry count is the one the exclusion list was written against"
    );
    for (index, name) in [
        (48, "user.tos_accepted_at"),
        (50, "user.tos_accepted_at"),
        (112, "transaction"),
        (115, "transaction"),
    ] {
        assert_eq!(
            script[index]["op"].as_str(),
            Some(name),
            "entry {index} is not what the exclusion list says it is"
        );
    }
    // Each entry is excluded exactly when the seam has no form for it: a transaction group
    // the capture rolled back, or one of the two raw-SQL probes. A filter carrying `search` is
    // no longer one of them — the store answers it from its term index.
    for (index, op) in script.iter().enumerate() {
        let name = op["op"].as_str().expect("an op name");
        let excluded_kind = match name {
            "transaction" => op["result"]["compare"]["failed"] != Value::Bool(false),
            "user.tos_accepted_at" => true,
            _ => false,
        };
        assert_eq!(
            EXCLUDED.contains(&index),
            excluded_kind,
            "entry {index} ({name}) is excluded exactly when the seam cannot run it"
        );
    }

    let (_directory, backend) = open_store().await;
    let corpus: Vec<EventRecord> = fixture["corpus"]
        .as_array()
        .expect("corpus")
        .iter()
        .map(common::event_record)
        .collect();
    backend
        .create_many(&corpus)
        .await
        .expect("the corpus inserts");

    let mut refs = HashMap::new();
    let mut replayed = 0;
    for (index, op) in script.iter().enumerate() {
        if EXCLUDED.contains(&index) {
            continue;
        }
        let name = op["op"].as_str().expect("an op name");
        let actual = if name == "transaction" {
            run_committed_transaction(&backend, op, &mut refs).await
        } else {
            common::run_op(Repos::all(&backend), op, &mut refs)
                .await
                .unwrap_or_else(|error| panic!("op {index} ({name}) failed: {error}"))
        };
        assert_eq!(
            actual, op["result"]["compare"],
            "op {index} ({name}) differs from the TypeScript capture"
        );
        replayed += 1;
    }
    assert_eq!(replayed, REPLAYED);
    println!("LMDB_PARITY_COMPLETE replayed={replayed} excluded={EXCLUDED_MARKER}");
}

#[tokio::test]
async fn a_soft_deleted_event_is_readable_by_filter_and_excluded_from_count() {
    let (_directory, backend) = open_store().await;
    let record = event(1, 1, 1_700_000_000);
    EventRepository::create(&backend, &record)
        .await
        .expect("the event stores");

    let filter = Filter {
        ids: Some(vec![record.event.id.to_string()]),
        ..Filter::default()
    };
    let live = collect_records(
        backend
            .find_by_filters(std::slice::from_ref(&filter))
            .await
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(live.len(), 1);
    assert!(live[0].deleted_at.is_none());

    assert_eq!(
        backend
            .delete_by_pubkey_and_ids(&record.event.pubkey, &[record.event.id])
            .await
            .unwrap(),
        1
    );

    let after = collect_records(
        backend
            .find_by_filters(std::slice::from_ref(&filter))
            .await
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        after.len(),
        1,
        "find_by_filters does not apply the live predicate (V14)"
    );
    assert!(
        after[0].deleted_at.is_some(),
        "the row carries its deletion time"
    );
    assert_eq!(
        backend
            .count_by_filters(std::slice::from_ref(&filter))
            .await
            .unwrap(),
        0,
        "count_by_filters applies the live predicate (V13)"
    );
    let items = common::collect(backend.find_reconciliation_items(&filter).await.unwrap())
        .await
        .unwrap();
    assert!(items.is_empty(), "reconciliation lists live rows only");
}

#[tokio::test]
async fn a_filter_result_larger_than_one_batch_arrives_whole_and_in_order() {
    let (_directory, backend) = open_store().await;
    // 500 is above STREAM_BATCH_ITEMS (256), so the stream copies at least two batches.
    let records: Vec<EventRecord> = (0..500)
        .map(|index| event((index % 200 + 1) as u8, 1, 1_700_000_000 + index))
        .collect();
    backend
        .create_many(&records)
        .await
        .expect("the events store");

    let filter = Filter {
        kinds: Some(vec![Kind(1)]),
        ..Filter::default()
    };
    let seen = collect_records(
        backend
            .find_by_filters(std::slice::from_ref(&filter))
            .await
            .unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(seen.len(), 500, "the whole page arrives");
    assert!(
        seen.windows(2)
            .all(|pair| pair[0].event.created_at < pair[1].event.created_at),
        "a filter without a limit orders by created_at ascending (V6)"
    );
}

#[tokio::test]
async fn admit_user_creates_an_admitted_row() {
    let (_directory, backend) = open_store().await;
    let pubkey = Pubkey::from_byte_array([7; 32]);
    assert!(backend.find_by_pubkey(&pubkey).await.unwrap().is_none());

    let admitted_at = Utc::now();
    backend.admit_user(&pubkey, admitted_at).await.unwrap();

    let user = backend
        .find_by_pubkey(&pubkey)
        .await
        .unwrap()
        .expect("the call creates the row");
    assert!(user.is_admitted);
    assert_eq!(user.balance, 0);
}

#[tokio::test]
async fn confirm_invoice_scales_by_unit_and_rejects_an_overflow() {
    let (_directory, backend) = open_store().await;
    let now = Utc::now();

    // sats: the credit is `amount_received × 1000` (V18).
    let sats_payee = Pubkey::from_byte_array([9; 32]);
    backend.admit_user(&sats_payee, now).await.unwrap();
    let sats_invoice = Invoice {
        id: "invoice-sats".to_owned(),
        pubkey: sats_payee,
        bolt11: "lnbc1".to_owned(),
        amount_requested: 1_000,
        amount_paid: None,
        unit: InvoiceUnit::Sats,
        status: InvoiceStatus::Pending,
        description: "test".to_owned(),
        confirmed_at: None,
        expires_at: None,
        updated_at: now,
        created_at: now,
        verify_url: None,
    };
    InvoiceRepository::upsert(&backend, &sats_invoice)
        .await
        .unwrap();
    backend
        .confirm_invoice("invoice-sats", 1_000, now)
        .await
        .unwrap();

    let confirmed = backend.find_by_id("invoice-sats").await.unwrap().unwrap();
    assert_eq!(confirmed.amount_paid, Some(1_000));
    assert!(confirmed.confirmed_at.is_some());
    assert_eq!(
        backend.get_balance_by_pubkey(&sats_payee).await.unwrap(),
        1_000_000
    );

    // btc: `amount_received × 100_000_000 × 1000`.
    let btc_payee = Pubkey::from_byte_array([10; 32]);
    backend.admit_user(&btc_payee, now).await.unwrap();
    let btc_invoice = Invoice {
        id: "invoice-btc".to_owned(),
        pubkey: btc_payee,
        unit: InvoiceUnit::Btc,
        ..sats_invoice.clone()
    };
    InvoiceRepository::upsert(&backend, &btc_invoice)
        .await
        .unwrap();
    backend
        .confirm_invoice("invoice-btc", 1, now)
        .await
        .unwrap();
    assert_eq!(
        backend.get_balance_by_pubkey(&btc_payee).await.unwrap(),
        100_000_000_000
    );

    // An `int8` overflow is an error, not a wrap, and nothing is written (V19).
    let overflowing = Invoice {
        id: "invoice-overflow".to_owned(),
        ..btc_invoice.clone()
    };
    InvoiceRepository::upsert(&backend, &overflowing)
        .await
        .unwrap();
    let before = backend.get_balance_by_pubkey(&btc_payee).await.unwrap();
    let error = backend
        .confirm_invoice("invoice-overflow", i64::MAX, now)
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            StorageError::ValueOutOfRange {
                column: "users.balance",
                ..
            }
        ),
        "an amount that cannot be scaled is ValueOutOfRange, got {error:?}"
    );
    assert_eq!(
        backend.get_balance_by_pubkey(&btc_payee).await.unwrap(),
        before,
        "the failed confirmation credits nothing"
    );
    assert!(
        backend
            .find_by_id("invoice-overflow")
            .await
            .unwrap()
            .unwrap()
            .confirmed_at
            .is_none(),
        "the failed confirmation leaves the invoice unconfirmed"
    );
}

#[tokio::test]
async fn a_nanosecond_instant_reads_back_at_microsecond_precision() {
    let (_directory, backend) = open_store().await;
    let now = Utc::now();
    let payee = Pubkey::from_byte_array([11; 32]);
    backend.admit_user(&payee, now).await.unwrap();
    // Three digits past the microsecond, which no `timestamp` column can hold (V38).
    let instant = DateTime::<Utc>::from_timestamp_nanos(1_700_000_000_123_456_789);
    let invoice = Invoice {
        id: "invoice-micros".to_owned(),
        pubkey: payee,
        bolt11: "lnbc1".to_owned(),
        amount_requested: 1,
        amount_paid: None,
        unit: InvoiceUnit::Sats,
        status: InvoiceStatus::Pending,
        description: "test".to_owned(),
        confirmed_at: None,
        expires_at: Some(instant),
        updated_at: now,
        created_at: instant,
        verify_url: None,
    };
    InvoiceRepository::upsert(&backend, &invoice).await.unwrap();

    let stored = backend.find_by_id("invoice-micros").await.unwrap().unwrap();
    assert_eq!(
        stored.created_at.timestamp_subsec_nanos(),
        123_456_000,
        "the insert truncates the caller's created_at (V38)"
    );
    assert_eq!(
        stored
            .expires_at
            .expect("the expiry")
            .timestamp_subsec_nanos(),
        123_456_000,
        "and its expires_at"
    );

    backend
        .confirm_invoice("invoice-micros", 1, instant)
        .await
        .unwrap();

    let confirmed_at = backend
        .find_by_id("invoice-micros")
        .await
        .unwrap()
        .unwrap()
        .confirmed_at
        .expect("the confirmation is stamped");
    assert_eq!(
        confirmed_at.timestamp_micros(),
        1_700_000_000_123_456,
        "a nanosecond instant reads back at microsecond precision (V38)"
    );
    assert_eq!(confirmed_at.timestamp_subsec_nanos(), 123_456_000);

    // The NIP-05 row keeps the caller's last check and verification at the same precision.
    use nostream_storage::repositories::Nip05VerificationRepository;

    let watched = Pubkey::from_byte_array([12; 32]);
    Nip05VerificationRepository::upsert(
        &backend,
        &Nip05Verification {
            pubkey: watched,
            nip05: "micros@example.test".to_owned(),
            domain: "example.test".to_owned(),
            is_verified: true,
            last_verified_at: Some(instant),
            last_checked_at: instant,
            failure_count: 0,
            created_at: instant,
            updated_at: instant,
        },
    )
    .await
    .unwrap();
    let verification = Nip05VerificationRepository::find_by_pubkey(&backend, &watched)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        verification.last_checked_at.timestamp_subsec_nanos(),
        123_456_000,
        "the NIP-05 row truncates last_checked_at"
    );
    assert_eq!(
        verification
            .last_verified_at
            .expect("the verification")
            .timestamp_subsec_nanos(),
        123_456_000,
        "and last_verified_at"
    );
}

#[tokio::test]
async fn a_delivery_log_entry_must_name_an_existing_outbox_row() {
    let (_directory, backend) = open_store().await;
    let unknown = one_entry(Some("00000000-0000-4000-8000-000000000000".to_owned()));
    match backend.append(&unknown).await {
        Err(StorageError::InvalidArgument { .. }) => {}
        other => panic!("an unknown outbox id is rejected, got {other:?}"),
    }
    assert!(
        backend
            .find_recent(10, &DeliveryLogFilters::default())
            .await
            .unwrap()
            .is_empty(),
        "the rejected entry is not stored"
    );

    let message = backend
        .enqueue("note.created", &json!({ "id": "note-1" }))
        .await
        .unwrap();
    backend.append(&one_entry(Some(message.id))).await.unwrap();
    assert_eq!(
        backend
            .find_recent(10, &DeliveryLogFilters::default())
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn a_target_id_a_text_column_cannot_hold_is_refused_rather_than_truncated() {
    let (_directory, backend) = open_store().await;
    let message = backend
        .enqueue("note.created", &json!({ "id": "note-3" }))
        .await
        .unwrap();
    let mut entry = one_entry(Some(message.id.clone()));
    entry.target_id = "https://example.test/\0hook".to_owned();

    // `notification_delivery_log.target_id` is a `text` column, and PostgreSQL cannot store
    // `0x00` in one, so the capture could never have kept this row; `append` refuses it through
    // `encoding::refuse_nul` rather than writing a value the other backend cannot hold.
    match backend.append(&entry).await {
        Err(StorageError::InvalidRow { column, .. }) => {
            assert_eq!(column, "target_id");
        }
        other => panic!("a NUL target id is refused, got {other:?}"),
    }
    assert!(
        backend
            .find_successful_target_ids(&message.id)
            .await
            .unwrap()
            .is_empty(),
        "the refused entry stored nothing to read back"
    );
}

#[tokio::test]
async fn deleting_an_outbox_row_nulls_its_delivery_log_entries() {
    let (_directory, backend) = open_store().await;
    let message = backend
        .enqueue("note.created", &json!({ "id": "note-2" }))
        .await
        .unwrap();
    backend
        .append(&one_entry(Some(message.id.clone())))
        .await
        .unwrap();
    backend.mark_delivered(&message.id).await.unwrap();

    let cutoff: DateTime<Utc> = Utc::now() + Duration::seconds(60);
    assert_eq!(
        backend.delete_terminal_older_than(cutoff).await.unwrap(),
        1,
        "the delivered row is deleted"
    );

    let entries = backend
        .find_recent(10, &DeliveryLogFilters::default())
        .await
        .unwrap();
    assert_eq!(entries.len(), 1, "the delivery log keeps its entry");
    assert!(
        entries[0].outbox_id.is_none(),
        "the deleted outbox row leaves no dangling id (V40)"
    );
}

#[tokio::test]
async fn an_invite_code_rejects_a_negative_remaining_uses() {
    let (_directory, backend) = open_store().await;
    let negative = CreateInviteCodeOptions {
        remaining_uses: FieldUpdate::Set(-5),
        ..CreateInviteCodeOptions::default()
    };
    match InviteCodeRepository::create(&backend, "negative", &negative).await {
        Err(StorageError::InvalidArgument { .. }) => {}
        other => panic!("a negative remaining_uses is rejected, got {other:?}"),
    }

    let zero = CreateInviteCodeOptions {
        remaining_uses: FieldUpdate::Set(0),
        ..CreateInviteCodeOptions::default()
    };
    let invite = InviteCodeRepository::create(&backend, "zero", &zero)
        .await
        .unwrap();
    assert_eq!(invite.remaining_uses, Some(0));
}

#[tokio::test]
async fn two_enqueues_return_distinct_uuids() {
    let (_directory, backend) = open_store().await;
    let first = backend
        .enqueue("note.created", &json!({ "id": "a" }))
        .await
        .unwrap();
    let second = backend
        .enqueue("note.created", &json!({ "id": "b" }))
        .await
        .unwrap();

    assert_ne!(first.id, second.id);
    assert_uuid_v4(&first.id);
    assert_uuid_v4(&second.id);
}

/// Five events of one author, created at 100, 200, … 500 seconds.
async fn five_events_of_one_author(backend: &LmdbBackend) -> Vec<EventRecord> {
    let records: Vec<EventRecord> = (1..=5).map(|step| event(5, 1, step * 100)).collect();
    backend
        .create_many(&records)
        .await
        .expect("the events store");
    records
}

/// The `created_at` values a page returned, newest first.
fn created_ats(records: &[EventRecord]) -> Vec<i64> {
    records
        .iter()
        .map(|record| record.event.created_at)
        .collect()
}

/// A signed event of one author, by the key `secret`, carrying `tags`.
fn tagged_event(secret: u8, created_at: i64, tags: Vec<Vec<String>>) -> EventRecord {
    let mut wire = Event {
        id: EventId::from_byte_array([0; 32]),
        pubkey: Pubkey::from_byte_array([0; 32]),
        created_at,
        kind: Kind(1),
        tags,
        content: format!("{secret}-{created_at}"),
        sig: Signature::from_byte_array([0; 64]),
    };
    nostream_core::crypto::sign_event(&[secret; 32], &mut wire).expect("the event signs");
    EventRecord::from_event(&wire)
}

#[tokio::test]
async fn a_limited_ids_filter_returns_the_newest_events() {
    let (_directory, backend) = open_store().await;
    let records = five_events_of_one_author(&backend).await;
    let filter = Filter {
        ids: Some(
            records
                .iter()
                .map(|record| record.event.id.to_string())
                .collect(),
        ),
        limit: Some(3),
        ..Filter::default()
    };

    let page = collect_records(
        backend
            .find_by_filters(std::slice::from_ref(&filter))
            .await
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        created_ats(&page),
        vec![500, 400, 300],
        "a limit orders the page newest first whatever index answered it (V6)"
    );
    assert_eq!(
        backend
            .count_by_filters(std::slice::from_ref(&filter))
            .await
            .unwrap(),
        3,
        "the count applies the same limit and order (V6)"
    );
}

#[tokio::test]
async fn a_limited_author_filter_returns_the_newest_events() {
    let (_directory, backend) = open_store().await;
    let records = five_events_of_one_author(&backend).await;
    let filter = Filter {
        authors: Some(vec![records[0].event.pubkey.to_string()]),
        limit: Some(3),
        ..Filter::default()
    };

    let page = collect_records(
        backend
            .find_by_filters(std::slice::from_ref(&filter))
            .await
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        created_ats(&page),
        vec![500, 400, 300],
        "a limit orders the page newest first whatever index answered it (V6)"
    );
}

/// The page and count of one filter: `(rows, count)`.
async fn page_and_count(backend: &LmdbBackend, filter: &Filter) -> (usize, u64) {
    let page = collect_records(
        backend
            .find_by_filters(std::slice::from_ref(filter))
            .await
            .unwrap(),
    )
    .await
    .unwrap();
    let count = backend
        .count_by_filters(std::slice::from_ref(filter))
        .await
        .unwrap();
    (page.len(), count)
}

#[tokio::test]
async fn an_id_prefix_of_either_parity_selects_the_event_it_prefixes() {
    let (_directory, backend) = open_store().await;
    let record = event(4, 1, 1_700_000_000);
    backend
        .create_many(std::slice::from_ref(&record))
        .await
        .expect("the event stores");
    let id = record.event.id.to_string();

    // The capture's `substring(event_id from 1 for n/2)` takes an even prefix's whole bytes,
    // and an odd one's final nibble is a range; both select the row (R12).
    for length in [8, 9, 16] {
        let filter = Filter {
            ids: Some(vec![id[..length].to_owned()]),
            ..Filter::default()
        };
        assert_eq!(
            page_and_count(&backend, &filter).await,
            (1, 1),
            "an id prefix of {length} characters names the row"
        );
    }

    let mut other = id[..8].to_owned();
    let digit = other.pop().expect("the prefix is not empty");
    other.push(if digit == '0' { '1' } else { '0' });
    let filter = Filter {
        ids: Some(vec![other]),
        ..Filter::default()
    };
    assert_eq!(
        page_and_count(&backend, &filter).await,
        (0, 0),
        "the prefix range stops at the prefix's own bytes"
    );
}

#[tokio::test]
async fn a_prefix_author_with_kinds_selects_the_event() {
    let (_directory, backend) = open_store().await;
    let record = event(12, 1, 1_700_000_000);
    backend
        .create_many(std::slice::from_ref(&record))
        .await
        .expect("the event stores");
    let author = record.event.pubkey.to_string();

    // The author index's key is `pubkey ‖ kind ‖ created_at ‖ event_id`, so the kind is at the
    // field's own offset whatever the author criterion covers (R12).
    for length in [8, 9, 16, 63, 64] {
        let filter = Filter {
            authors: Some(vec![author[..length].to_owned()]),
            kinds: Some(vec![Kind(1)]),
            ..Filter::default()
        };
        assert_eq!(
            page_and_count(&backend, &filter).await,
            (1, 1),
            "an author prefix of {length} characters with the row's kind names it"
        );

        let filter = Filter {
            authors: Some(vec![author[..length].to_owned()]),
            kinds: Some(vec![Kind(2)]),
            ..Filter::default()
        };
        assert_eq!(
            page_and_count(&backend, &filter).await,
            (0, 0),
            "another kind excludes it at the same offset"
        );
    }
}

#[tokio::test]
async fn a_repeated_kind_counts_its_row_once() {
    let (_directory, backend) = open_store().await;
    let note = event(13, 1, 1_700_000_000);
    let highest = event(14, i32::MAX as u64, 1_700_000_001);
    backend
        .create_many(&[note.clone(), highest.clone()])
        .await
        .expect("the events store");

    // A duplicated criterion, and two kinds that the key codec maps to the same `i32`, name one
    // index range; a count that visited it per criterion would count the row twice (V6, UNION).
    for (record, kinds) in [
        (&note, vec![Kind(1), Kind(1)]),
        (
            &highest,
            vec![Kind(i32::MAX as u64), Kind(i32::MAX as u64 + 1)],
        ),
    ] {
        let filter = Filter {
            authors: Some(vec![record.event.pubkey.to_string()]),
            kinds: Some(kinds),
            ..Filter::default()
        };
        assert_eq!(
            page_and_count(&backend, &filter).await,
            (1, 1),
            "the row is one row however its kind is repeated"
        );
    }
}

#[tokio::test]
async fn a_reconciliation_lists_every_live_row_across_batches() {
    let (_directory, backend) = open_store().await;
    let records: Vec<EventRecord> = (0..500)
        .map(|index| event((index % 200 + 1) as u8, 1, 1_700_000_000 + index))
        .collect();
    backend
        .create_many(&records)
        .await
        .expect("the events store");

    let filter = Filter {
        kinds: Some(vec![Kind(1)]),
        limit: Some(1),
        ..Filter::default()
    };
    let items = common::collect(backend.find_reconciliation_items(&filter).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        items.len(),
        500,
        "every live row arrives, not one per batch fewer (R20)"
    );
    assert!(
        items
            .windows(2)
            .all(|pair| (pair[0].created_at, pair[0].event_id)
                < (pair[1].created_at, pair[1].event_id)),
        "reconciliation is oldest first and ignores the filter's limit"
    );
}

#[tokio::test]
async fn a_reconciliation_over_ids_lists_exactly_those_rows_oldest_first() {
    let (_directory, backend) = open_store().await;
    let records: Vec<EventRecord> = (0..300)
        .map(|index| event(41, 1, 1_700_000_000 + index))
        .collect();
    backend
        .create_many(&records)
        .await
        .expect("the events store");

    let filter = Filter {
        ids: Some(vec![
            records[250].event.id.to_string(),
            records[12].event.id.to_string(),
            records[199].event.id.to_string(),
        ]),
        ..Filter::default()
    };
    let items = common::collect(backend.find_reconciliation_items(&filter).await.unwrap())
        .await
        .unwrap();

    assert_eq!(
        items,
        vec![
            ReconciliationItem {
                created_at: 1_700_000_012,
                event_id: records[12].event.id,
            },
            ReconciliationItem {
                created_at: 1_700_000_199,
                event_id: records[199].event.id,
            },
            ReconciliationItem {
                created_at: 1_700_000_250,
                event_id: records[250].event.id,
            },
        ],
        "the request's ids, oldest first, whatever order the ids arrive in"
    );
}

#[tokio::test]
async fn a_reconciliation_over_an_id_prefix_lists_every_row_the_prefix_selects() {
    // A prefix criterion is a byte range over the id field rather than the request's own list,
    // so it is answered by the bounded created-at scan; `""` is that range over every row.
    let (_directory, backend) = open_store().await;
    let records: Vec<EventRecord> = (0..400)
        .map(|index| event(42, 1, 1_700_000_000 + index))
        .collect();
    backend
        .create_many(&records)
        .await
        .expect("the events store");

    let filter = Filter {
        ids: Some(vec![String::new()]),
        ..Filter::default()
    };
    let items = common::collect(backend.find_reconciliation_items(&filter).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        items.len(),
        400,
        "every row the criterion selects arrives across the batches"
    );
    assert!(
        items
            .windows(2)
            .all(|pair| (pair[0].created_at, pair[0].event_id)
                < (pair[1].created_at, pair[1].event_id)),
        "and oldest first"
    );

    let prefix = records[7].event.id.to_string()[..2].to_owned();
    let filter = Filter {
        ids: Some(vec![prefix.clone()]),
        ..Filter::default()
    };
    let items = common::collect(backend.find_reconciliation_items(&filter).await.unwrap())
        .await
        .unwrap();
    let expected: Vec<ReconciliationItem> = records
        .iter()
        .filter(|record| record.event.id.to_string().starts_with(&prefix))
        .map(|record| ReconciliationItem {
            created_at: record.event.created_at,
            event_id: record.event.id,
        })
        .collect();
    assert!(
        !expected.is_empty(),
        "the prefix selects the row it came from"
    );
    assert_eq!(
        items, expected,
        "the prefix selects the same rows, oldest first"
    );
}

#[tokio::test]
async fn an_empty_tag_value_criterion_matches_nothing() {
    let (_directory, backend) = open_store().await;
    let record = tagged_event(3, 1_700_000_000, vec![vec!["e".to_owned(), String::new()]]);
    EventRepository::create(&backend, &record)
        .await
        .expect("the event stores");

    let mut filter = Filter {
        ids: Some(vec![record.event.id.to_string()]),
        limit: Some(10),
        ..Filter::default()
    };
    let reachable = collect_records(
        backend
            .find_by_filters(std::slice::from_ref(&filter))
            .await
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(reachable.len(), 1, "the row is reachable by its id");

    filter.tags.insert("#e".to_owned(), vec![String::new()]);
    let page = collect_records(
        backend
            .find_by_filters(std::slice::from_ref(&filter))
            .await
            .unwrap(),
    )
    .await
    .unwrap();
    assert!(
        page.is_empty(),
        "event_tags holds no empty value, so no row can match one (V42)"
    );
}

#[tokio::test]
async fn an_empty_criterion_family_matches_nothing() {
    let (_directory, backend) = open_store().await;
    let record = event(6, 1, 1_700_000_000);
    EventRepository::create(&backend, &record)
        .await
        .expect("the event stores");

    for filter in [
        Filter {
            ids: Some(Vec::new()),
            ..Filter::default()
        },
        Filter {
            authors: Some(Vec::new()),
            ..Filter::default()
        },
        Filter {
            tags: BTreeMap::from([("#e".to_owned(), Vec::new())]),
            ..Filter::default()
        },
    ] {
        let page = collect_records(
            backend
                .find_by_filters(std::slice::from_ref(&filter))
                .await
                .unwrap(),
        )
        .await
        .unwrap();
        assert!(
            page.is_empty(),
            "a present-but-empty family matches nothing, not the next path (V45): {filter:?}"
        );
        assert_eq!(
            backend
                .count_by_filters(std::slice::from_ref(&filter))
                .await
                .unwrap(),
            0,
            "the count of an empty family is zero (V45): {filter:?}"
        );
    }
}

#[tokio::test]
async fn a_delivery_log_entry_keeps_its_index_entry_when_a_sibling_is_pruned() {
    let (_directory, backend) = open_store().await;
    let message = backend
        .enqueue("note.created", &json!({ "id": "note-3" }))
        .await
        .unwrap();
    let entry = one_entry(Some(message.id.clone()));
    backend.append(&entry).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    backend.append(&entry).await.unwrap();

    let entries = backend
        .find_recent(10, &DeliveryLogFilters::default())
        .await
        .unwrap();
    assert_eq!(entries.len(), 2, "two attempts, one target");
    let cutoff = entries[1].created_at + Duration::milliseconds(1);
    assert_eq!(
        backend.delete_older_than(cutoff).await.unwrap(),
        1,
        "only the older attempt is pruned"
    );
    assert_eq!(
        backend
            .find_successful_target_ids(&message.id)
            .await
            .unwrap(),
        vec![entry.target_id.clone()],
        "the surviving attempt keeps its index entry (V40)"
    );
}

#[tokio::test]
async fn a_retention_pass_classifies_a_row_once_and_spares_the_whitelist() {
    let (_directory, backend) = open_store().await;
    let now = Utc::now();
    let long_ago = 1_700_000_000;
    let expired_at = now.timestamp() - 1;

    // Deleted and expired at once: the capture counts it as deleted, and its precedence is
    // what makes the total one row rather than two (R13, V8).
    let deleted_and_expired = event(21, 1, long_ago).with_expires_at(expired_at);
    let expired_only = event(22, 1, long_ago).with_expires_at(expired_at);
    let retained_only = event(23, 1, long_ago);
    // Every whitelist keeps kind 62, so this row is never a candidate.
    let vanish = event(24, 62, long_ago);
    backend
        .create_many(&[
            deleted_and_expired.clone(),
            expired_only,
            retained_only,
            vanish.clone(),
        ])
        .await
        .expect("the events store");
    assert_eq!(
        backend
            .delete_by_pubkey_and_ids(
                &deleted_and_expired.event.pubkey,
                &[deleted_and_expired.event.id]
            )
            .await
            .unwrap(),
        1
    );

    let skipped = backend
        .delete_expired_and_retained(&EventRetentionOptions {
            max_days: Some(0),
            kind_whitelist: None,
            pubkey_whitelist: None,
        })
        .await
        .unwrap();
    assert_eq!(
        (skipped.deleted, skipped.expired, skipped.retained),
        (0, 0, 0),
        "max_days 0 touches nothing (V8)"
    );

    let counts = backend
        .delete_expired_and_retained(&EventRetentionOptions {
            max_days: Some(1),
            kind_whitelist: None,
            pubkey_whitelist: None,
        })
        .await
        .unwrap();
    assert_eq!(
        (counts.deleted, counts.expired, counts.retained),
        (1, 1, 1),
        "each qualifying row is classified once, in the capture's precedence"
    );

    let filter = Filter {
        ids: Some(vec![vanish.event.id.to_string()]),
        ..Filter::default()
    };
    let survivors = collect_records(
        backend
            .find_by_filters(std::slice::from_ref(&filter))
            .await
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        survivors.len(),
        1,
        "a kind-62 row survives an empty configured whitelist (V8)"
    );
}

#[tokio::test]
async fn a_retention_pass_takes_at_most_one_batch_of_candidates() {
    let (_directory, backend) = open_store().await;
    let records: Vec<EventRecord> = (0..1_001)
        .map(|index| event((index % 200 + 1) as u8, 1, 1_700_000_000 + index))
        .collect();
    backend
        .create_many(&records)
        .await
        .expect("the events store");

    let options = EventRetentionOptions {
        max_days: Some(1),
        kind_whitelist: None,
        pubkey_whitelist: None,
    };
    let first = backend.delete_expired_and_retained(&options).await.unwrap();
    assert_eq!(
        (first.deleted, first.expired, first.retained),
        (0, 0, 1_000),
        "one pass takes RETENTION_BATCH_SIZE candidates (V7)"
    );
    let second = backend.delete_expired_and_retained(&options).await.unwrap();
    assert_eq!(
        (second.deleted, second.expired, second.retained),
        (0, 0, 1),
        "the next pass takes the row the batch ceiling left behind"
    );
}

/// A `LIMIT 0` returns no rows, in every finder whose walk arms its bound after the first
/// match: Postgres answers an empty list, so a bound of zero must not return one.
#[tokio::test]
async fn a_zero_limit_returns_no_rows() {
    use nostream_storage::repositories::{Nip05VerificationRepository, ReportRepository};

    let (_directory, backend) = open_store().await;
    let now = Utc::now();

    let watched = Pubkey::from_byte_array([21; 32]);
    Nip05VerificationRepository::upsert(
        &backend,
        &Nip05Verification {
            pubkey: watched,
            nip05: "pending@example.test".to_owned(),
            domain: "example.test".to_owned(),
            is_verified: false,
            last_verified_at: None,
            last_checked_at: now - Duration::hours(2),
            failure_count: 0,
            created_at: now - Duration::hours(2),
            updated_at: now - Duration::hours(2),
        },
    )
    .await
    .unwrap();
    assert!(
        backend
            .find_pending_verifications(0, 3, 1)
            .await
            .unwrap()
            .len()
            == 1,
        "the row the zero limit must not return"
    );
    assert!(
        backend
            .find_pending_verifications(0, 3, 0)
            .await
            .unwrap()
            .is_empty(),
        "a zero limit returns no pending verification"
    );

    InviteCodeRepository::create(
        &backend,
        "invite-zero",
        &CreateInviteCodeOptions {
            expires_at: Some(now + Duration::hours(1)),
            remaining_uses: FieldUpdate::Set(3),
            created_by: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(backend.find_active_codes(1).await.unwrap().len(), 1);
    assert!(
        backend.find_active_codes(0).await.unwrap().is_empty(),
        "a zero limit returns no invite code"
    );

    ReportRepository::create(
        &backend,
        &NewReport {
            event_id: EventId::from_byte_array([22; 32]),
            reporter_pubkey: Pubkey::from_byte_array([23; 32]),
            reported_pubkey: Some(Pubkey::from_byte_array([24; 32])),
            reported_event_id: None,
            report_type: ReportType::Spam,
            weight: 1.0,
            actionable: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(backend.find_actionable(1).await.unwrap().len(), 1);
    assert!(
        backend.find_actionable(0).await.unwrap().is_empty(),
        "a zero limit returns no report"
    );

    backend.append(&one_entry(None)).await.unwrap();
    let filters = DeliveryLogFilters::default();
    assert_eq!(backend.find_recent(1, &filters).await.unwrap().len(), 1);
    assert!(
        backend.find_recent(0, &filters).await.unwrap().is_empty(),
        "a zero limit returns no delivery-log entry"
    );
}

/// `dvm_jobs.id` is the primary key: creating a row that already exists is refused instead of
/// overwriting the worker and result a later state wrote.
#[tokio::test]
async fn creating_a_job_that_exists_is_refused() {
    use nostream_storage::repositories::DvmJobRepository;

    let (_directory, backend) = open_store().await;
    let id = EventId::from_byte_array([31; 32]);
    let requester = Pubkey::from_byte_array([32; 32]);

    DvmJobRepository::create(&backend, &id, &requester, Kind(5_000))
        .await
        .expect("the job");
    assert!(backend.assign_worker(&id, 3).await.unwrap());

    let error = DvmJobRepository::create(&backend, &id, &requester, Kind(5_000))
        .await
        .expect_err("a second create of the same id");
    assert!(
        matches!(error, StorageError::InvalidArgument { .. }),
        "the primary key refuses the row, got {error:?}"
    );

    let stored = DvmJobRepository::find_by_id(&backend, &id)
        .await
        .unwrap()
        .expect("the job");
    assert_eq!(stored.status, DvmJobStatus::PickedUp);
    assert_eq!(
        stored.worker_index,
        Some(3),
        "the refused create changed nothing"
    );
}

// ---------------------------------------------------------------------------------------
// NIP-50: the term index, the tokeniser and the rank, over a real store.
// ---------------------------------------------------------------------------------------

/// The four rows the capture recorded for `{"search":"bitcoin lightning"}`, in its order — the
/// Postgres `ts_rank` order, which this store's proximity rank reproduces on this corpus.
const RECORDED_SEARCH_IDS: [&str; 4] = [
    "5454369c2445e12b001b51e5e48cf6722072ecdb187453c028cac8a12040633a",
    "c004000000000000000000000000000000000000000000000000000000000000",
    "cb41289d08a5784a73b7bac2bf97620f5c927487d0c5a029ba81f840fe21fa36",
    "9ae1fef4857bb0174e8fb1221f8da1da6705ebef42e143de7a8f8fe965ba9ee3",
];

/// A search over the fixture's corpus returns the capture's four rows, in the capture's order,
/// and not the fifth row the relay's substring matcher would select (`bitcoininveniice`).
#[tokio::test]
async fn a_search_returns_the_recorded_rows_in_rank_order() {
    let fixture = fixture();
    let (_directory, backend) = open_store().await;
    let corpus: Vec<EventRecord> = fixture["corpus"]
        .as_array()
        .expect("corpus")
        .iter()
        .map(common::event_record)
        .collect();
    backend
        .create_many(&corpus)
        .await
        .expect("the corpus inserts");

    let page = rows_of(&backend, &search("bitcoin lightning")).await;
    let ids: Vec<String> = page
        .iter()
        .map(|record| record.event.id.to_string())
        .collect();
    assert_eq!(
        ids, RECORDED_SEARCH_IDS,
        "R3, R5, R6: the recorded rows in rank order"
    );
}

#[tokio::test]
async fn a_search_that_matches_nothing_yields_no_rows() {
    let (_directory, backend) = open_store().await;
    backend
        .create_many(&[event_with_content(90, 1, 1_700_000_000, "bitcoin")])
        .await
        .expect("the event stores");

    let page = rows_of(&backend, &search("bitcoin zzznotpresent")).await;
    assert!(page.is_empty(), "a term no body carries selects nothing");
}

#[tokio::test]
async fn a_search_applies_every_criterion_it_is_combined_with() {
    let (_directory, backend) = open_store().await;
    let e1 = event_with_tags(
        1,
        1,
        1_700_000_100,
        "commonterm",
        vec![vec!["t".to_owned(), "alpha".to_owned()]],
    );
    let e2 = event_with_content(2, 0, 1_700_000_200, "commonterm");
    let e3 = event_with_content(1, 1, 1_700_000_300, "commonterm");
    let e4 = event_with_content(3, 1, 1_700_000_400, "commonterm");
    let e5 = event_with_content(1, 1, 1_700_000_500, "commonterm");
    backend
        .create_many(&[e1.clone(), e2.clone(), e3.clone(), e4.clone(), e5.clone()])
        .await
        .expect("the events store");
    nostream_storage::repositories::ReportRepository::create(
        &backend,
        &NewReport {
            event_id: EventId::from_byte_array([44; 32]),
            reporter_pubkey: Pubkey::from_byte_array([45; 32]),
            reported_pubkey: Some(e4.event.pubkey),
            reported_event_id: Some(e4.event.id),
            report_type: ReportType::Spam,
            weight: 1.0,
            actionable: true,
        },
    )
    .await
    .expect("the report stores");

    let cases = [
        (
            Filter {
                kinds: Some(vec![Kind(1)]),
                ..search("commonterm")
            },
            vec![&e1, &e3, &e5],
            "kinds",
        ),
        (
            search("commonterm"),
            vec![&e1, &e2, &e3, &e5],
            "search alone",
        ),
        (
            Filter {
                ids: Some(vec![e2.event.id.to_string()]),
                ..search("commonterm")
            },
            vec![&e2],
            "ids",
        ),
        (
            Filter {
                authors: Some(vec![e2.event.pubkey.to_string()]),
                ..search("commonterm")
            },
            vec![&e2],
            "authors",
        ),
        (
            Filter {
                since: Some(1_700_000_200),
                ..search("commonterm")
            },
            vec![&e2, &e3, &e5],
            "since",
        ),
        (
            Filter {
                until: Some(1_700_000_200),
                ..search("commonterm")
            },
            vec![&e1, &e2],
            "until",
        ),
        (
            Filter {
                tags: BTreeMap::from([("#t".to_owned(), vec!["alpha".to_owned()])]),
                ..search("commonterm")
            },
            vec![&e1],
            "#t",
        ),
    ];
    for (filter, expected, what) in cases {
        let page = rows_of(&backend, &filter).await;
        assert_set_in_id_order(&page, &expected, what);
    }
}

#[tokio::test]
async fn a_search_orders_by_proximity_then_event_id() {
    let (_directory, backend) = open_store().await;
    let adjacent_one = event_with_content(10, 1, 1_700_000_000, "bitcoin lightning");
    let adjacent_two = event_with_content(11, 1, 1_700_000_000, "lightning bitcoin");
    let adjacent_three = event_with_content(12, 1, 1_700_000_000, "lightning bitcoin");
    let spread = event_with_content(13, 1, 1_700_000_000, "bitcoin x y lightning");
    backend
        .create_many(&[
            spread.clone(),
            adjacent_three.clone(),
            adjacent_one.clone(),
            adjacent_two.clone(),
        ])
        .await
        .expect("the events store");

    let mut tied = [adjacent_one, adjacent_two, adjacent_three];
    tied.sort_by_key(|record| record.event.id);
    for query in ["bitcoin lightning", "Bitcoin LIGHTNING"] {
        let page = rows_of(&backend, &search(query)).await;
        let expected = [&tied[0], &tied[1], &tied[2], &spread];
        assert_eq!(
            ids_of(&page),
            expected
                .iter()
                .map(|record| record.event.id)
                .collect::<Vec<_>>(),
            "{query}: three span-2 rows in id order, then the span-4 row"
        );
    }
}

#[tokio::test]
async fn a_search_finds_a_term_at_the_end_of_a_large_content() {
    let (_directory, backend) = open_store().await;
    let long = format!("{} needle", "a".repeat(200_000));
    let long_run = event_with_content(20, 1, 1_700_000_000, &long);
    let hundred = event_with_content(21, 1, 1_700_000_000, &"b".repeat(100));
    let first = format!("{}x", "c".repeat(64));
    let second = format!("{}y", "c".repeat(64));
    let shared_one = event_with_content(22, 1, 1_700_000_000, &first);
    let shared_two = event_with_content(23, 1, 1_700_000_000, &second);
    backend
        .create_many(&[
            long_run.clone(),
            hundred.clone(),
            shared_one.clone(),
            shared_two.clone(),
        ])
        .await
        .expect("the events store");

    for (query, expected, what) in [
        (
            "needle".to_owned(),
            &long_run,
            "a token after a 200 000-character run is found",
        ),
        (
            "b".repeat(100),
            &hundred,
            "a term longer than the key cap is found",
        ),
        (
            first.clone(),
            &shared_one,
            "the first of two tokens sharing 64 bytes",
        ),
        (
            second.clone(),
            &shared_two,
            "the second of two tokens sharing 64 bytes",
        ),
    ] {
        let page = rows_of(&backend, &search(&query)).await;
        assert_eq!(ids_of(&page), vec![expected.event.id], "{what}");
    }
}

#[tokio::test]
async fn the_term_index_follows_create_replace_and_retention() {
    let (_directory, backend) = open_store().await;

    let alpha = event_with_content(30, 1, 1_700_000_000, "uniquealpha");
    EventRepository::create(&backend, &alpha)
        .await
        .expect("the event stores");
    assert_eq!(
        ids_of(&rows_of(&backend, &search("uniquealpha")).await),
        vec![alpha.event.id]
    );
    assert_eq!(index_keys(&backend, "uniquealpha"), 1, "one posting");

    let beta = event_with_content(31, 0, 1_700_000_000, "uniquebeta");
    assert_eq!(
        EventRepository::upsert(&backend, &beta)
            .await
            .expect("the upsert"),
        1
    );
    let gamma = event_with_content(31, 0, 1_700_000_100, "uniquegamma");
    assert_eq!(
        EventRepository::upsert(&backend, &gamma)
            .await
            .expect("the replacement"),
        1
    );
    assert!(rows_of(&backend, &search("uniquebeta")).await.is_empty());
    assert_eq!(
        index_keys(&backend, "uniquebeta"),
        0,
        "the replaced row's postings left"
    );
    assert_eq!(
        ids_of(&rows_of(&backend, &search("uniquegamma")).await),
        vec![gamma.event.id]
    );
    assert_eq!(index_keys(&backend, "uniquegamma"), 1);

    let delta = event_with_content(32, 1, 1_700_000_000, "uniquedelta")
        .with_expires_at(Utc::now().timestamp() - 1);
    backend
        .create_many(std::slice::from_ref(&delta))
        .await
        .expect("the event stores");
    let counts = backend
        .delete_expired_and_retained(&EventRetentionOptions {
            max_days: Some(1),
            kind_whitelist: None,
            pubkey_whitelist: None,
        })
        .await
        .expect("the retention pass");
    assert_eq!(counts.expired, 1);
    assert!(rows_of(&backend, &search("uniquedelta")).await.is_empty());
    assert_eq!(
        index_keys(&backend, "uniquedelta"),
        0,
        "the retained row's postings left"
    );

    let token = event_with_content(33, 1, 1_700_000_000, "uniquetoken");
    EventRepository::create(&backend, &token)
        .await
        .expect("the event stores");
    assert_eq!(
        backend
            .delete_by_pubkey_and_ids(&token.event.pubkey, &[token.event.id])
            .await
            .expect("the soft delete"),
        1
    );
    assert_eq!(
        ids_of(&rows_of(&backend, &search("uniquetoken")).await),
        vec![token.event.id],
        "a soft-deleted row is still found, as `find_by_filters` reads it"
    );
    assert_eq!(
        index_keys(&backend, "uniquetoken"),
        1,
        "the soft delete rewrites the value, not the terms"
    );
}

#[tokio::test]
async fn a_search_page_honours_the_limit() {
    let (_directory, backend) = open_store().await;
    let records: Vec<EventRecord> = (0..5)
        .map(|step| event_with_content(40 + step, 1, 1_700_000_000 + i64::from(step), "commonterm"))
        .collect();
    backend
        .create_many(&records)
        .await
        .expect("the events store");
    let mut by_id = sorted_ids(&records);

    let page = rows_of(&backend, &search("commonterm")).await;
    assert_eq!(ids_of(&page), by_id, "no limit: every row, in id order");

    let empty = rows_of(
        &backend,
        &Filter {
            limit: Some(0),
            ..search("commonterm")
        },
    )
    .await;
    assert!(empty.is_empty(), "limit 0 yields no rows");

    by_id.truncate(2);
    let two = rows_of(
        &backend,
        &Filter {
            limit: Some(2),
            ..search("commonterm")
        },
    )
    .await;
    assert_eq!(ids_of(&two), by_id, "limit 2: the two best by (rank, id)");
}

#[tokio::test]
async fn a_count_applies_the_search_predicate() {
    let (directory, backend) = open_with(settings_from_fixture(&fixture())).await;
    let live = event_with_content(50, 1, 1_700_000_000, "matchterm");
    let deleted = event_with_content(51, 1, 1_700_000_100, "matchterm more");
    let other = event_with_content(52, 1, 1_700_000_200, "otherthing");
    backend
        .create_many(&[live, deleted.clone(), other])
        .await
        .expect("the events store");
    backend
        .delete_by_pubkey_and_ids(&deleted.event.pubkey, &[deleted.event.id])
        .await
        .expect("the soft delete");

    assert_eq!(
        backend
            .count_by_filters(&[search("matchterm")])
            .await
            .expect("the count"),
        1,
        "the live match is counted, the soft-deleted one is not"
    );
    drop(backend);

    let reopened = LmdbBackend::open(directory.path())
        .await
        .expect("the store reopens")
        .with_settings(Arc::new(settings_with("nip50.enabled", json!(false))));
    assert_eq!(
        reopened
            .count_by_filters(&[search("matchterm")])
            .await
            .expect("the gate-off count"),
        2,
        "with the gate off the field is ignored, as Postgres ignores it"
    );
    assert_eq!(
        reopened
            .count_by_filters(&[Filter::default()])
            .await
            .expect("the unfiltered count"),
        2,
        "and the count is the count of the other criteria's rows"
    );
}

#[tokio::test]
async fn a_limited_count_counts_the_rank_page() {
    let (_directory, backend) = open_store().await;
    let spread: Vec<EventRecord> = (1..=4)
        .map(|step| {
            event_with_content(
                60 + step,
                1,
                1_700_000_000 + i64::from(step),
                "alpha x y z beta",
            )
        })
        .collect();
    let m5 = event_with_content(70, 1, 1_700_000_500, "alpha beta");
    let m6 = event_with_content(71, 1, 1_700_000_600, "alpha beta");
    let mut all = spread.clone();
    all.push(m5.clone());
    all.push(m6.clone());
    backend.create_many(&all).await.expect("the events store");

    let limited = Filter {
        limit: Some(2),
        ..search("alpha beta")
    };
    let page = rows_of(&backend, &limited).await;
    let mut best = vec![m5.event.id, m6.event.id];
    best.sort();
    assert_eq!(ids_of(&page), best, "the rank-best two, not the newest two");

    let mut first_filter = [spread[0].event.id, spread[1].event.id];
    first_filter.sort();
    let total = backend
        .count_by_filters(&[
            Filter {
                ids: Some(first_filter.iter().map(ToString::to_string).collect()),
                ..Filter::default()
            },
            limited,
        ])
        .await
        .expect("the count");
    assert_eq!(
        total, 4,
        "the limited branch contributes its rank page's two rows"
    );
}

/// A search is applied by the reconciliation stream too, and its rows arrive oldest first: the
/// stream keeps its created-at order and its batches, and the matcher refuses the rest.
#[tokio::test]
async fn reconciliation_applies_the_search_predicate() {
    let (_directory, backend) = open_store().await;
    let earlier = event_with_content(70, 1, 1_700_000_000, "reachableterm");
    let between = event_with_content(71, 1, 1_700_000_050, "unrelated");
    let later = event_with_content(72, 1, 1_700_000_100, "reachableterm again");
    backend
        .create_many(&[later, earlier.clone(), between])
        .await
        .expect("the events store");

    let items = common::collect(
        backend
            .find_reconciliation_items(&search("reachableterm"))
            .await
            .expect("the stream"),
    )
    .await
    .expect("the items");

    assert_eq!(
        items.len(),
        2,
        "only the two rows whose bodies carry the term"
    );
    assert_eq!(
        items.iter().map(|item| item.created_at).collect::<Vec<_>>(),
        vec![1_700_000_000, 1_700_000_100],
        "oldest first, as the stream promises"
    );
    assert_eq!(items[0].event_id, earlier.event.id);
}

#[tokio::test]
async fn a_blank_search_is_ignored_and_a_tokenless_query_selects_nothing() {
    let (_directory, backend) = open_store().await;
    let the_cat = event_with_content(80, 1, 1_700_000_000, "the cat");
    let a_cat = event_with_content(81, 1, 1_700_000_100, "a cat");
    let bitcoin = event_with_content(82, 1, 1_700_000_200, "bitcoin");
    backend
        .create_many(&[the_cat.clone(), a_cat, bitcoin.clone()])
        .await
        .expect("the events store");

    for blank in ["", "   "] {
        assert_eq!(
            rows_of(&backend, &search(blank)).await.len(),
            3,
            "{blank:?} is not a search, so every row of the other criteria arrives"
        );
    }
    assert!(
        rows_of(&backend, &search("!!!")).await.is_empty(),
        "a query whose every character is punctuation has no token, so it selects nothing"
    );
    assert_eq!(
        ids_of(&rows_of(&backend, &search("the")).await),
        vec![the_cat.event.id],
        "`simple` has no stop list, so `the` is an ordinary token"
    );

    let padded = format!("{} bitcoin", ".".repeat(250));
    assert!(
        rows_of(&backend, &search(&padded)).await.is_empty(),
        "the 256-character cut leaves `bitco`, which is not the token `bitcoin`"
    );
    assert_eq!(
        ids_of(&rows_of(&backend, &search("bitcoin")).await),
        vec![bitcoin.event.id],
        "and the unprefixed query still finds it"
    );
}

#[tokio::test]
async fn a_search_never_matches_a_tag_value() {
    let (_directory, backend) = open_store().await;
    let record = event_with_tags(
        85,
        1,
        1_700_000_000,
        "hello world",
        vec![vec!["t".to_owned(), "bitcoin".to_owned()]],
    );
    backend
        .create_many(std::slice::from_ref(&record))
        .await
        .expect("the event stores");

    assert!(
        rows_of(&backend, &search("bitcoin")).await.is_empty(),
        "the index is built from `content`, so a tag value is never a posting"
    );
    assert_eq!(
        ids_of(&rows_of(&backend, &search("hello")).await),
        vec![record.event.id]
    );
}

#[tokio::test]
async fn a_search_under_a_language_the_index_cannot_reproduce_is_refused() {
    let (directory, backend) = open_with(settings_with("nip50.language", json!("english"))).await;
    let record = event_with_content(90, 1, 1_700_000_000, "study");
    backend
        .create_many(std::slice::from_ref(&record))
        .await
        .expect("the event stores");

    let filter = search("study");
    let page = backend.find_by_filters(std::slice::from_ref(&filter)).await;
    let count = backend
        .count_by_filters(std::slice::from_ref(&filter))
        .await;
    let reconciliation = backend.find_reconciliation_items(&filter).await;

    for error in [
        page.err().unwrap_or_else(|| panic!("the page is refused")),
        count
            .err()
            .unwrap_or_else(|| panic!("the count is refused")),
        reconciliation
            .err()
            .expect("the stream is refused, not its items"),
    ] {
        assert!(
            matches!(error, StorageError::InvalidArgument { .. }),
            "a language the index cannot reproduce is InvalidArgument, got {error:?}"
        );
        assert!(
            error.to_string().contains("simple"),
            "the message names the configuration: {error}"
        );
    }
    drop(backend);

    let reopened = LmdbBackend::open(directory.path())
        .await
        .expect("the store reopens")
        .with_settings(Arc::new(settings_from_fixture(&fixture())));
    assert!(
        rows_of(&reopened, &search("studies")).await.is_empty(),
        "`simple` has no stemmer, so `studies` does not find `study`"
    );
    assert_eq!(
        ids_of(&rows_of(&reopened, &search("study")).await),
        vec![record.event.id]
    );
}

#[tokio::test]
async fn the_search_rule_names_the_simple_configuration_when_the_gate_is_on() {
    let (_directory, enabled) = open_with(settings_from_fixture(&fixture())).await;
    assert_eq!(
        enabled.search_rule(),
        SearchRule::ToTsvector {
            language: "simple".to_owned()
        },
        "the declared rule is the rule the term index applies"
    );

    let directory = tempfile::tempdir().expect("tempdir");
    let bare = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");
    assert_eq!(
        bare.search_rule(),
        SearchRule::SubstringTerms,
        "with the gate off no predicate is applied, and the relay's matcher is what decides"
    );
}

#[tokio::test]
async fn a_store_whose_index_was_maintained_with_the_gate_off_answers_the_search_when_it_is_on() {
    let (directory, backend) = open_with(settings_with("nip50.enabled", json!(false))).await;
    let record = event_with_content(95, 1, 1_700_000_000, "latentterm");
    backend
        .create_many(std::slice::from_ref(&record))
        .await
        .expect("the event stores");
    drop(backend);

    let reopened = LmdbBackend::open(directory.path())
        .await
        .expect("the store reopens")
        .with_settings(Arc::new(settings_from_fixture(&fixture())));
    assert_eq!(
        ids_of(&rows_of(&reopened, &search("latentterm")).await),
        vec![record.event.id],
        "the write path indexes whether or not the read gate is on"
    );
}

/// Three events whose contents are one distinctive token each, the store the two rebuild tests
/// start from, with the index forgotten the way a store written before it existed has none.
async fn store_without_an_index() -> (tempfile::TempDir, Vec<EventRecord>) {
    let (directory, backend) = open_with(settings_from_fixture(&fixture())).await;
    let records: Vec<EventRecord> = ["rebuiltalpha", "rebuiltbeta", "rebuiltgamma"]
        .iter()
        .enumerate()
        .map(|(step, content)| event_with_content(100 + step as u8, 1, 1_700_000_000, content))
        .collect();
    backend
        .create_many(&records)
        .await
        .expect("the events store");
    {
        let env = backend.env();
        let rtxn = env.read_txn().expect("a read transaction");
        let (index, meta) = named_databases(env, &rtxn);
        drop(rtxn);
        let mut wtxn = env.write_txn().expect("a write transaction");
        index.clear(&mut wtxn).expect("the index clears");
        meta.delete(&mut wtxn, SEARCH_INDEX_MARKER)
            .expect("the marker clears");
        wtxn.commit().expect("the commit");
    }
    drop(backend);
    (directory, records)
}

#[tokio::test]
async fn a_store_written_without_the_index_is_rebuilt_on_open() {
    let (directory, records) = store_without_an_index().await;
    let reopened = LmdbBackend::open(directory.path())
        .await
        .expect("the store reopens")
        .with_settings(Arc::new(settings_from_fixture(&fixture())));

    {
        let env = reopened.env();
        let rtxn = env.read_txn().expect("a read transaction");
        let (index, meta) = named_databases(env, &rtxn);
        assert_eq!(
            index.len(&rtxn).expect("the index's length"),
            3,
            "the index is populated before the first search, not lazily by it"
        );
        assert_eq!(
            meta.get(&rtxn, SEARCH_INDEX_MARKER)
                .expect("the marker reads"),
            Some(&[SEARCH_INDEX_VERSION][..]),
            "and the marker records the rebuild"
        );
    }
    assert_eq!(
        ids_of(&rows_of(&reopened, &search("rebuiltalpha")).await),
        vec![records[0].event.id]
    );
}

#[tokio::test]
async fn an_index_from_an_older_tokenizer_is_rebuilt_on_open() {
    let (directory, records) = store_without_an_index().await;
    {
        let env = {
            let backend = LmdbBackend::open(directory.path())
                .await
                .expect("the store opens");
            backend.env().clone()
        };
        let rtxn = env.read_txn().expect("a read transaction");
        let (index, meta) = named_databases(&env, &rtxn);
        drop(rtxn);
        let mut wtxn = env.write_txn().expect("a write transaction");
        meta.put(&mut wtxn, SEARCH_INDEX_MARKER, &[SEARCH_INDEX_VERSION + 1])
            .expect("the stale marker");
        let mut ghost = b"ghostterm".to_vec();
        ghost.extend([0u8; 32]);
        index
            .put(&mut wtxn, &ghost, &[])
            .expect("the stale posting");
        wtxn.commit().expect("the commit");
    }

    let reopened = LmdbBackend::open(directory.path())
        .await
        .expect("the store reopens")
        .with_settings(Arc::new(settings_from_fixture(&fixture())));
    {
        let env = reopened.env();
        let rtxn = env.read_txn().expect("a read transaction");
        let (index, meta) = named_databases(env, &rtxn);
        assert_eq!(
            meta.get(&rtxn, SEARCH_INDEX_MARKER)
                .expect("the marker reads"),
            Some(&[SEARCH_INDEX_VERSION][..]),
            "the rebuild repaired the marker before the first search"
        );
        assert_eq!(
            index.len(&rtxn).expect("the index's length"),
            3,
            "the index was replaced, not extended: an add-only rebuild would read 4"
        );
        assert_eq!(
            index
                .prefix_iter(&rtxn, b"ghostterm")
                .expect("the index reads")
                .count(),
            0,
            "the posting no current row carries is gone"
        );
    }
    assert_eq!(
        ids_of(&rows_of(&reopened, &search("rebuiltbeta")).await),
        vec![records[1].event.id]
    );
}
