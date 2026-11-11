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
use nostream_core::{Event, EventId, Filter, Kind, Pubkey, Signature};
use nostream_storage::LmdbBackend;
use nostream_storage::StorageError;
use nostream_storage::repositories::{
    CreateInviteCodeOptions, DeliveryLogFilters, DvmJobStatus, EventRecord, EventRepository,
    EventRetentionOptions, FieldUpdate, InviteCodeRepository, Invoice, InvoiceRepository,
    InvoiceStatus, InvoiceUnit, NewDeliveryLogEntry, NewReport, Nip05Verification,
    NotificationDeliveryLogRepository, NotificationDeliveryStatus, NotificationOutboxRepository,
    NotificationTargetType, ReconciliationItem, ReportType, SearchRule, UserRepository,
    collect_records,
};

mod common;

/// The entries this arm cannot replay, fixed by index: 48 and 50 are `user.tos_accepted_at`
/// (raw SQL, no seam form), and 112 and 115 are the two `transaction` groups the capture rolled
/// back — a seam with no rollback cannot reproduce them. The two groups it committed (111, 117)
/// are replayed: their nested ops in order leave exactly the state the commit left, which is why
/// entries after 111 observe its rows. Entry 21, the one filter carrying `search`, is replayed
/// against the token rule the backend applies.
// shortcut: four fixture entries are excluded by index and the count is a constant; upgrade
// when the capture gains an entry, which fails the count assertion and forces this list to be
// re-derived rather than quietly skipped.
const EXCLUDED: [usize; 4] = [48, 50, 112, 115];

/// The entries that are replayed; `EXCLUDED.len() + REPLAYED` is the fixture's entry count.
const REPLAYED: usize = 114;

/// The exclusion list as the marker line prints it.
const EXCLUDED_MARKER: &str = "48,50,112,115";

/// The fixture entry carrying a NIP-50 `search`: the capture recorded its rows from Postgres in
/// `ts_rank` order, which this backend does not reproduce, so the test re-sorts them into the
/// page order a filter without a `limit` produces.
const SEARCHED_ENTRY: usize = 21;

/// The ids entry 21 records, in page order (`created_at` ascending): the token rule's whole
/// answer over the fixture corpus. The substring rule adds [`NOT_SEARCHED_ID`], which is why
/// this backend applies the token rule.
const SEARCHED_IDS: [&str; 4] = [
    "5454369c2445e12b001b51e5e48cf6722072ecdb187453c028cac8a12040633a",
    "9ae1fef4857bb0174e8fb1221f8da1da6705ebef42e143de7a8f8fe965ba9ee3",
    "cb41289d08a5784a73b7bac2bf97620f5c927487d0c5a029ba81f840fe21fa36",
    "c004000000000000000000000000000000000000000000000000000000000000",
];

/// The row the substring rule returns for entry 21 and the token rule refuses: its content
/// carries `bitcoininveniice` and `#LightningNetwork`, and neither run is a query term.
const NOT_SEARCHED_ID: &str = "f8ef979358ca737fcff947314572c83bb9725dc2695590575390c8b42a5c4939";

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

/// The value one entry is compared with: the capture's own `result.compare`, except for the
/// searched entry, whose recorded rows are re-sorted into the page order this backend produces
/// (no `limit`, so `created_at` ascending, the id ascending on a tie). The rows are the
/// fixture's and the sort is the test's, never the implementation's: the capture recorded
/// `ts_rank` order, which this backend does not reproduce, and the fixture stays the capture's
/// answer.
fn expected_result(index: usize, op: &Value) -> Value {
    let mut compare = op["result"]["compare"].clone();
    if index != SEARCHED_ENTRY {
        return compare;
    }
    let rows = compare["rows"]
        .as_array_mut()
        .expect("the searched entry's rows");
    rows.sort_by(|left, right| {
        left[1]
            .as_i64()
            .cmp(&right[1].as_i64())
            .then_with(|| left[0].as_str().cmp(&right[0].as_str()))
    });
    compare
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

/// A signed event of the given kind, creation time, content and tags, by the key `secret`.
fn signed(secret: u8, kind: u64, created_at: i64, content: &str, tags: &[&[&str]]) -> EventRecord {
    let mut event = Event {
        id: EventId::from_byte_array([0; 32]),
        pubkey: Pubkey::from_byte_array([0; 32]),
        created_at,
        kind: Kind(kind),
        tags: tags
            .iter()
            .map(|tag| tag.iter().map(|value| (*value).to_owned()).collect())
            .collect(),
        content: content.to_owned(),
        sig: Signature::from_byte_array([0; 64]),
    };
    nostream_core::crypto::sign_event(&[secret; 32], &mut event).expect("the event signs");
    EventRecord::from_event(&event)
}

/// A filter as the store's own types read it — the wire's `search`, `kinds`, `#t` and the rest.
fn wire(value: Value) -> Filter {
    serde_json::from_value(value).expect("the filter parses")
}

/// The rows a filter returns, in page order.
async fn page(backend: &LmdbBackend, filter: Filter) -> Vec<EventRecord> {
    collect_records(
        backend
            .find_by_filters(std::slice::from_ref(&filter))
            .await
            .expect("the read answers"),
    )
    .await
    .expect("the stream drains")
}

/// The ids a page returns, in its order.
fn ids(rows: &[EventRecord]) -> Vec<String> {
    rows.iter()
        .map(|record| record.event.id.to_string())
        .collect()
}

/// The compared shape of a page's rows.
fn rows(page: &[EventRecord]) -> Vec<Value> {
    page.iter().map(common::event_row).collect()
}

/// The live rows a filter counts.
async fn counted(backend: &LmdbBackend, filter: Filter) -> u64 {
    backend
        .count_by_filters(std::slice::from_ref(&filter))
        .await
        .expect("the count answers")
}

/// C3's five events, in the order that criterion numbers them: two authors (the keys 71 and
/// 72), both kinds, and a row carrying the tag `#t=alpha` with a content that lacks the term.
fn combined_events() -> Vec<EventRecord> {
    vec![
        signed(71, 1, 100, "commonterm", &[&["t", "alpha"]]),
        signed(72, 0, 200, "commonterm extra", &[]),
        signed(71, 1, 300, "COMMONTERM", &[]),
        signed(72, 0, 400, "commonterm", &[]),
        signed(71, 1, 500, "otherterm", &[&["t", "alpha"]]),
    ]
}

/// A gate-on store holding `events`.
async fn store_with(events: &[EventRecord]) -> (tempfile::TempDir, LmdbBackend) {
    let (directory, backend) = open_store().await;
    backend
        .create_many(events)
        .await
        .expect("the corpus inserts");
    (directory, backend)
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
    // Each entry is excluded exactly when the seam has no form for it: a transaction group the
    // capture rolled back, or one of the two raw-SQL probes. A filter carrying `search` is run.
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
            actual,
            expected_result(index, op),
            "op {index} ({name}) differs from the TypeScript capture"
        );
        if index == SEARCHED_ENTRY {
            let ids: Vec<&str> = actual["rows"]
                .as_array()
                .expect("the searched entry's rows")
                .iter()
                .map(|row| row[0].as_str().expect("an id"))
                .collect();
            assert_eq!(
                ids, SEARCHED_IDS,
                "the token rule's four rows, in page order"
            );
            assert!(
                !ids.contains(&NOT_SEARCHED_ID),
                "the row the substring rule adds is refused"
            );
        }
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

/// The rule is the token rule: lowercase both strings, split each into maximal runs of
/// alphanumeric characters, and require every query term to equal one of the content's runs.
/// That is not `Filter::matches`'s substring rule (which accepts `abcdef` inside
/// `xxabcdefyy`), not Postgres' stemming one (`study` selects `studies` under `english`), and
/// a tag carrying a term is never enough.
#[tokio::test]
async fn a_search_rule_is_lowercase_alphanumeric_tokens() {
    let (_directory, backend) = open_store().await;
    let events = vec![
        signed(61, 1, 100, "xxabcdefyy", &[]),
        signed(62, 1, 200, "studies", &[]),
        signed(63, 1, 300, "MIXED Case", &[]),
        signed(64, 1, 400, "the word the", &[]),
        signed(65, 1, 500, "theory other", &[]),
        signed(66, 1, 600, "bitcoin lightning both", &[]),
        signed(67, 1, 700, "only bitcoin", &[]),
        signed(68, 1, 800, "plain", &[&["t", "needle"]]),
    ];
    backend
        .create_many(&events)
        .await
        .expect("the corpus inserts");

    assert!(
        page(&backend, wire(json!({"search": "abcdef"})))
            .await
            .is_empty(),
        "`xxabcdefyy` is one token, so `abcdef` matches nothing"
    );
    assert!(
        page(&backend, wire(json!({"search": "study"})))
            .await
            .is_empty(),
        "no stemming: `studies` is another token"
    );
    assert_eq!(
        ids(&page(&backend, wire(json!({"search": "mixed case"}))).await),
        ids(&events[2..3]),
        "both strings lowercase, so the mixed-case content matches"
    );
    assert_eq!(
        ids(&page(&backend, wire(json!({"search": "the"}))).await),
        ids(&events[3..4]),
        "`the` matches the word and not `theory` or `other`"
    );
    assert_eq!(
        ids(&page(&backend, wire(json!({"search": "bitcoin lightning"}))).await),
        ids(&events[5..6]),
        "both terms must be runs of the content"
    );
    assert!(
        page(&backend, wire(json!({"search": "needle"})))
            .await
            .is_empty(),
        "a tag carrying the term is never enough"
    );
    assert!(
        page(&backend, wire(json!({"search": "!!!"})))
            .await
            .is_empty(),
        "a query with no alphanumeric run matches nothing"
    );
    assert_eq!(
        backend.search_rule(),
        SearchRule::TokenTerms,
        "the declared rule is the one applied"
    );
}

/// A search narrows together with every criterion it is combined with, `#t` included: the tag
/// index proves that family for the keys it selects, and a verdict placed behind that proof
/// would be skipped — E5 carries `alpha` and not the term.
#[tokio::test]
async fn a_search_combines_with_every_other_criterion() {
    let events = combined_events();
    let (_directory, backend) = store_with(&events).await;
    let [e1, e2, e3, e4, _] = &events[..] else {
        panic!("the corpus is five events")
    };
    let (a1, a2) = (e1.event.pubkey.to_string(), e2.event.pubkey.to_string());
    assert_ne!(a1, a2, "the corpus has two authors");

    assert_eq!(
        ids(&page(&backend, wire(json!({"search": "commonterm"}))).await),
        ids(&events[..4]),
        "the query alone selects E1–E4"
    );
    assert_eq!(
        ids(&page(
            &backend,
            wire(json!({"search": "commonterm", "kinds": [1]}))
        )
        .await),
        ids(&[e1.clone(), e3.clone()]),
        "kind 1 narrows the search to E1 and E3"
    );
    assert_eq!(
        ids(&page(
            &backend,
            wire(json!({"search": "commonterm", "ids": [e2.event.id.to_string()]}))
        )
        .await),
        ids(std::slice::from_ref(e2)),
        "an id narrows the search to E2"
    );
    assert_eq!(
        ids(&page(
            &backend,
            wire(json!({"search": "commonterm", "authors": [a2]}))
        )
        .await),
        ids(&[e2.clone(), e4.clone()]),
        "an author narrows the search to E2 and E4"
    );
    assert_eq!(
        ids(&page(
            &backend,
            wire(json!({"search": "commonterm", "since": 300}))
        )
        .await),
        ids(&[e3.clone(), e4.clone()]),
        "`since` is inclusive and narrows the search to E3 and E4"
    );
    assert_eq!(
        ids(&page(
            &backend,
            wire(json!({"search": "commonterm", "since": 200}))
        )
        .await),
        ids(&events[1..4]),
        "an event exactly at the bound is returned"
    );
    assert_eq!(
        ids(&page(
            &backend,
            wire(json!({"search": "commonterm", "until": 200}))
        )
        .await),
        ids(&events[..2]),
        "`until` is inclusive and narrows the search to E1 and E2"
    );
    assert_eq!(
        ids(&page(
            &backend,
            wire(json!({"search": "commonterm", "#t": ["alpha"]}))
        )
        .await),
        ids(std::slice::from_ref(e1)),
        "the tag family narrows the search to E1: a `proven` family skips the tag check, not \
         the search verdict, and E5 carries the tag and not the term"
    );
}

/// A searched page is bounded like any other — the default 500, `limit`, and `limit: 0` — while
/// a count with no limit counts every match. A limit-bearing read applies the predicate too, so
/// the page is the best *matches*, not the best rows.
#[tokio::test]
async fn a_search_page_is_bounded_by_the_default_limit_but_a_count_is_not() {
    let (_directory, backend) = open_store().await;
    let events: Vec<EventRecord> = (0..501i64)
        .map(|index| signed(80, 1, 1_700_000_000 + index, "needle", &[]))
        .collect();
    backend
        .create_many(&events)
        .await
        .expect("the corpus inserts");

    let bounded = page(&backend, wire(json!({"search": "needle"}))).await;
    assert_eq!(bounded.len(), 500, "the default page holds 500 rows");
    assert_eq!(
        bounded.first().map(|record| record.event.created_at),
        Some(1_700_000_000),
        "without a limit the page is the oldest matches first"
    );
    assert_eq!(
        bounded.last().map(|record| record.event.created_at),
        Some(1_700_000_499),
        "the 501st match is past the page"
    );
    assert_eq!(
        counted(&backend, wire(json!({"search": "needle"}))).await,
        501,
        "a count is not page-bounded"
    );

    let newest = page(&backend, wire(json!({"search": "needle", "limit": 3}))).await;
    assert_eq!(
        newest
            .iter()
            .map(|record| record.event.created_at)
            .collect::<Vec<_>>(),
        vec![1_700_000_500, 1_700_000_499, 1_700_000_498],
        "a limit makes the page the newest matches first"
    );
    assert!(
        page(&backend, wire(json!({"search": "needle", "limit": 0})))
            .await
            .is_empty(),
        "a zero limit returns no rows"
    );

    let events = combined_events();
    let (_second_directory, backend) = store_with(&events).await;
    assert_eq!(
        ids(&page(&backend, wire(json!({"search": "commonterm", "limit": 2}))).await),
        ids(&[events[3].clone(), events[2].clone()]),
        "the limit truncates the matches: E4 then E3, newest first"
    );
    assert_eq!(
        ids(&page(&backend, wire(json!({"limit": 2}))).await),
        ids(&[events[4].clone(), events[3].clone()]),
        "without the search the page is the newest rows: E5 then E4"
    );
}

/// A count applies the search predicate, with every criterion it combines with, and a count
/// with a `limit` counts the limited page.
#[tokio::test]
async fn a_count_applies_the_search_predicate() {
    let events = combined_events();
    let (_directory, backend) = store_with(&events).await;

    assert_eq!(
        counted(&backend, wire(json!({"search": "commonterm"}))).await,
        4,
        "E1–E4"
    );
    assert_eq!(
        counted(
            &backend,
            wire(json!({"search": "commonterm", "kinds": [1]}))
        )
        .await,
        2,
        "E1 and E3"
    );
    assert_eq!(
        counted(
            &backend,
            wire(json!({"search": "commonterm", "#t": ["alpha"]}))
        )
        .await,
        1,
        "E1"
    );
    assert_eq!(
        counted(&backend, wire(json!({"search": "commonterm", "limit": 3}))).await,
        3,
        "a limited count counts a page of that size"
    );
}

/// A reconciliation applies the search predicate and yields its matches oldest first, and the
/// old refusal is gone: no read returns `NotImplemented` for a search the gate enables.
#[tokio::test]
async fn a_reconciliation_applies_the_search_predicate() {
    let events = combined_events();
    let (_directory, backend) = store_with(&events).await;

    let filter = wire(json!({"search": "commonterm"}));
    let items = common::collect(
        backend
            .find_reconciliation_items(&filter)
            .await
            .expect("the filter is admitted"),
    )
    .await
    .expect("the stream drains");
    assert_eq!(
        items
            .iter()
            .map(|item| item.event_id.to_string())
            .collect::<Vec<_>>(),
        ids(&events[..4]),
        "E1–E4, oldest first"
    );

    let tagged = wire(json!({"search": "commonterm", "#t": ["alpha"]}));
    let items = common::collect(
        backend
            .find_reconciliation_items(&tagged)
            .await
            .expect("the filter is admitted"),
    )
    .await
    .expect("the stream drains");
    assert_eq!(
        items
            .iter()
            .map(|item| item.event_id.to_string())
            .collect::<Vec<_>>(),
        ids(&events[..1]),
        "the tag family narrows it to E1"
    );
    assert_eq!(
        items.len() as u64,
        counted(&backend, tagged).await,
        "the stream's length is the count over the same filter"
    );
}

/// With the NIP-50 gate off a search is not a predicate, so the read is the read without it;
/// with the gate on the same corpus applies it. One test, two halves: the gate-off half keeps
/// the change from leaking past the gate, and the gate-on half is what fails without it.
#[tokio::test]
async fn a_search_the_gate_disables_is_ignored() {
    let events = combined_events();
    let (_on_directory, on) = store_with(&events).await;
    let off_directory = tempfile::tempdir().expect("tempdir");
    let off = LmdbBackend::open(off_directory.path())
        .await
        .expect("a store without settings opens");
    off.create_many(&events).await.expect("the corpus inserts");

    assert_eq!(
        rows(&page(&off, wire(json!({"search": "commonterm", "kinds": [1]}))).await),
        rows(&page(&off, wire(json!({"kinds": [1]}))).await),
        "with the gate off a search changes nothing"
    );
    assert_eq!(
        counted(&off, wire(json!({"search": "commonterm", "kinds": [1]}))).await,
        counted(&off, wire(json!({"kinds": [1]}))).await,
        "with the gate off a search counts nothing differently"
    );
    assert_eq!(
        off.search_rule(),
        SearchRule::SubstringTerms,
        "with the gate off the backend declares the default rule"
    );

    assert_eq!(
        ids(&page(&on, wire(json!({"search": "commonterm", "kinds": [1]}))).await),
        ids(&[events[0].clone(), events[2].clone()]),
        "with the gate on the predicate is applied: E1 and E3"
    );
    assert_eq!(
        ids(&page(&on, wire(json!({"kinds": [1]}))).await),
        ids(&[events[0].clone(), events[2].clone(), events[4].clone()]),
        "and E5 is the row the predicate removes"
    );
    assert_eq!(
        on.search_rule(),
        SearchRule::TokenTerms,
        "with the gate on the backend declares the token rule"
    );
}

/// A blank query is not a search — Postgres' `is_search`, not the core matcher's
/// whitespace-only branch — and a non-blank one is. One test, two halves: the blank half fails
/// if the core matcher's rule is applied to a whitespace query, and the non-blank half fails if
/// the field is ignored for every query.
#[tokio::test]
async fn a_blank_search_is_not_a_search() {
    let events = combined_events();
    let (_directory, backend) = store_with(&events).await;
    let kinds_only = page(&backend, wire(json!({"kinds": [1]}))).await;

    for blank in ["", "   "] {
        let filter = Filter {
            search: Some(blank.to_owned()),
            kinds: Some(vec![Kind(1)]),
            ..Filter::default()
        };
        assert_eq!(
            rows(&page(&backend, filter.clone()).await),
            rows(&kinds_only),
            "the blank query {blank:?} is ignored"
        );
        assert_eq!(
            counted(&backend, filter).await,
            counted(&backend, wire(json!({"kinds": [1]}))).await,
            "the blank query {blank:?} counts what its other criteria count"
        );
    }

    assert_eq!(
        ids(&page(&backend, wire(json!({"search": "commonterm"}))).await),
        ids(&events[..4]),
        "a non-blank query selects E1–E4"
    );
    assert_eq!(
        ids(&page(&backend, wire(json!({}))).await),
        ids(&events),
        "and the same filter without it selects all five"
    );
}
