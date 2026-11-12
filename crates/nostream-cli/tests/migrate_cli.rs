//! The `migrate pg-to-lmdb` command's contract: the copy, the manifest, resume, verify and the
//! run's own throughput measurement.
//!
//! Every test drives `migrate_with`/`verify_with` over a constructed source and a real
//! `LmdbBackend` on a `TempDir`, so no database and no process is involved; the one test that
//! needs a process runs the binary and reads its stderr.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use heed::types::Bytes;
use serde_json::{Value, json};

use nostream_cli::commands::migrate::{self, MigrateOptions};
use nostream_core::{Event, EventId, Filter, Kind, Pubkey, Signature};
use nostream_storage::LmdbBackend;
use nostream_storage::StorageError;
use nostream_storage::migration::{
    MigratedTable, MigratedUser, MigrationRow, MigrationSource, MigrationTarget,
};
use nostream_storage::repositories::{
    DeliveryLogEntry, DeliveryLogFilters, DvmJob, DvmJobRepository, DvmJobStatus, EventRecord,
    EventRepository, InviteCode, InviteCodeRepository, Invoice, InvoiceRepository, InvoiceStatus,
    InvoiceUnit, NewReport, Nip05Verification, Nip05VerificationRepository,
    NotificationDeliveryLogRepository, NotificationDeliveryStatus, NotificationTargetType,
    OutboxMessage, OutboxStatus, Report, ReportRepository, ReportType, StorageFuture, User,
    UserRepository, collect_records,
};

// ---------------------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------------------

/// One whole-second instant, 2020-01-01T00:00:00Z plus `offset` seconds, so every fixture
/// timestamp is at the microsecond precision the store keeps.
fn at(offset: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(1_577_836_800 + offset, 0)
        .single()
        .expect("a whole second")
}

fn instant(text: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(text)
        .expect("a fixture instant")
        .with_timezone(&Utc)
}

fn event_id(seed: u8) -> EventId {
    EventId::from_byte_array([seed; 32])
}

fn pubkey(seed: u8) -> Pubkey {
    Pubkey::from_byte_array([seed; 32])
}

/// A live, unexpiring text note.
fn event_record(seed: u8, content: &str) -> EventRecord {
    EventRecord {
        row_id: None,
        event: Event {
            id: event_id(seed),
            pubkey: pubkey(1),
            created_at: 1_600_000_000 + i64::from(seed),
            kind: Kind::TEXT_NOTE,
            tags: Vec::new(),
            content: content.to_owned(),
            sig: Signature::from_byte_array([9; 64]),
        },
        first_seen: Some(at(0)),
        deleted_at: None,
        expires_at: None,
        event_deduplication: None,
        remote_address: None,
    }
}

fn dvm_job(seed: u8) -> DvmJob {
    DvmJob {
        id: event_id(seed),
        requester_pubkey: pubkey(2),
        kind: Kind(5100),
        worker_index: Some(1),
        status: DvmJobStatus::Completed,
        result_event_id: Some(event_id(200 + seed)),
        error: None,
        picked_up_at: Some(at(10)),
        completed_at: Some(at(20)),
        created_at: at(i64::from(seed)),
        updated_at: at(30),
    }
}

fn invite(seed: u8) -> InviteCode {
    InviteCode {
        code: format!("code-{seed}"),
        created_by: Some(pubkey(3)),
        claimed_by: None,
        expires_at: Some(at(100)),
        remaining_uses: Some(2),
        created_at: at(i64::from(seed)),
        updated_at: at(40),
    }
}

/// The third invoice is the pending one, which is the row the pending index has to hold.
fn invoice(seed: u8) -> Invoice {
    let pending = seed == 3;
    Invoice {
        id: format!("00000000-0000-4000-8000-00000000000{seed}"),
        pubkey: pubkey(4),
        bolt11: format!("lnbc1invoice{seed}"),
        amount_requested: 1_000,
        amount_paid: (!pending).then_some(1_000),
        unit: InvoiceUnit::Msats,
        status: if pending {
            InvoiceStatus::Pending
        } else {
            InvoiceStatus::Completed
        },
        description: "an invoice".to_owned(),
        confirmed_at: (!pending).then(|| at(50)),
        expires_at: Some(at(60)),
        updated_at: at(70),
        created_at: at(i64::from(seed)),
        verify_url: None,
    }
}

fn nip05(seed: u8) -> Nip05Verification {
    Nip05Verification {
        pubkey: pubkey(20 + seed),
        nip05: format!("user{seed}@example.com"),
        domain: "example.com".to_owned(),
        is_verified: true,
        last_verified_at: Some(at(80)),
        last_checked_at: at(90),
        failure_count: 1,
        created_at: at(i64::from(seed)),
        updated_at: at(100),
    }
}

fn outbox_id(seed: u8) -> String {
    format!("10000000-0000-4000-8000-00000000000{seed}")
}

fn outbox(seed: u8) -> OutboxMessage {
    OutboxMessage {
        id: outbox_id(seed),
        event_type: "invoice.paid".to_owned(),
        payload: json!({ "amount": 1_000 }),
        status: OutboxStatus::Delivered,
        attempt_count: 1,
        available_at: at(120),
        last_error: None,
        delivered_at: Some(at(130)),
        created_at: at(i64::from(seed)),
        updated_at: at(140),
    }
}

fn delivery_log(seed: u8) -> DeliveryLogEntry {
    DeliveryLogEntry {
        id: format!("20000000-0000-4000-8000-00000000000{seed}"),
        outbox_id: Some(outbox_id(seed)),
        event_type: "invoice.paid".to_owned(),
        target_id: "telegram:7175022".to_owned(),
        target_type: NotificationTargetType::Telegram,
        status: NotificationDeliveryStatus::Success,
        attempt_number: 1,
        error_snippet: None,
        created_at: at(110 + i64::from(seed)),
    }
}

fn report(seed: u8) -> Report {
    Report {
        id: i32::from(seed),
        event_id: event_id(40 + seed),
        reporter_pubkey: pubkey(5),
        reported_pubkey: Some(pubkey(6)),
        reported_event_id: None,
        report_type: ReportType::Spam,
        weight: 1.5,
        actionable: true,
        created_at: at(i64::from(seed)),
    }
}

fn user(seed: u8) -> MigratedUser {
    MigratedUser {
        user: User {
            pubkey: pubkey(30 + seed),
            is_admitted: true,
            is_vanished: false,
            balance: 0,
            created_at: at(i64::from(seed)),
            updated_at: at(150),
        },
        tos_accepted_at: None,
    }
}

/// Three rows per table, which is the source every whole-run test copies.
fn source_rows() -> Vec<MigrationRow> {
    let mut rows = Vec::new();
    for seed in 1..=3 {
        rows.push(MigrationRow::DvmJob(dvm_job(seed)));
        rows.push(MigrationRow::Event(event_record(seed, "hello")));
        rows.push(MigrationRow::InviteCode(invite(seed)));
        rows.push(MigrationRow::Invoice(invoice(seed)));
        rows.push(MigrationRow::Nip05Verification(nip05(seed)));
        rows.push(MigrationRow::DeliveryLogEntry(delivery_log(seed)));
        rows.push(MigrationRow::OutboxMessage(outbox(seed)));
        rows.push(MigrationRow::Report(report(seed)));
        rows.push(MigrationRow::User(user(seed)));
    }
    rows
}

fn rows_of(rows: &[MigrationRow], table: MigratedTable) -> Vec<MigrationRow> {
    let mut selected: Vec<MigrationRow> = rows
        .iter()
        .filter(|row| row.table() == table)
        .cloned()
        .collect();
    selected.sort_by_key(MigrationRow::key);
    selected
}

// ---------------------------------------------------------------------------------------
// The injected source.
// ---------------------------------------------------------------------------------------

/// A source that serves a fixed row set, in key order, and records every call it is asked for.
struct StubSource {
    rows: Vec<MigrationRow>,
    /// The ordinal of the call that answers `Err`, if any.
    fail_at: Option<usize>,
    calls: Mutex<Vec<(MigratedTable, Option<Vec<u8>>)>>,
}

impl StubSource {
    fn new(rows: Vec<MigrationRow>) -> Self {
        Self {
            rows,
            fail_at: None,
            calls: Mutex::new(Vec::new()),
        }
    }

    fn failing_at(rows: Vec<MigrationRow>, ordinal: usize) -> Self {
        Self {
            fail_at: Some(ordinal),
            ..Self::new(rows)
        }
    }

    fn calls(&self) -> Vec<(MigratedTable, Option<Vec<u8>>)> {
        self.calls
            .lock()
            .expect("the counter is not poisoned")
            .clone()
    }
}

impl MigrationSource for StubSource {
    fn read_batch<'a>(
        &'a self,
        table: MigratedTable,
        after: Option<&'a [u8]>,
        limit: usize,
    ) -> StorageFuture<'a, Vec<MigrationRow>> {
        Box::pin(async move {
            let ordinal = {
                let mut calls = self.calls.lock().expect("the counter is not poisoned");
                calls.push((table, after.map(<[u8]>::to_vec)));
                calls.len() - 1
            };
            if self.fail_at == Some(ordinal) {
                return Err(StorageError::InvalidArgument {
                    message: "the stub's read failed",
                });
            }

            let mut rows = rows_of(&self.rows, table);
            if let Some(after) = after {
                rows.retain(|row| row.key().as_slice() > after);
            }
            rows.truncate(limit);
            Ok(rows)
        })
    }
}

// ---------------------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------------------

fn options(directory: &std::path::Path, batch_size: usize) -> MigrateOptions {
    MigrateOptions {
        target: directory.to_owned(),
        batch_size,
        verify: false,
    }
}

fn manifest_bytes(directory: &std::path::Path) -> Vec<u8> {
    std::fs::read(directory.join("migration-manifest.json")).expect("the manifest is written")
}

/// The manifest of the shape R6 writes: nine entries, `rows: 0`, the zero checksum, `after: ""`,
/// and `complete` as the caller asks.
fn write_manifest_fixture(directory: &std::path::Path, complete: bool) {
    let manifest = json!({
        "format": 1,
        "not_migrated": MigratedTable::NOT_MIGRATED,
        "tables": MigratedTable::ALL
            .iter()
            .map(|table| (
                table.name().to_owned(),
                json!({"rows": 0, "checksum": "0".repeat(64), "after": "", "complete": complete}),
            ))
            .collect::<BTreeMap<_, _>>(),
    });
    std::fs::write(
        directory.join("migration-manifest.json"),
        serde_json::to_vec(&manifest).expect("the fixture manifest serialises"),
    )
    .expect("the fixture manifest is written");
}

fn manifest(directory: &std::path::Path) -> Value {
    serde_json::from_slice(&manifest_bytes(directory)).expect("the manifest is JSON")
}

fn output_text(out: Vec<u8>) -> String {
    String::from_utf8(out).expect("the command writes utf-8")
}

/// `time_key`: the flip-signed seconds, then the event id — the shape the two event tail
/// indexes are keyed by.
fn time_key(seconds: i64, id: EventId) -> Vec<u8> {
    let mut key = ((seconds as u64) ^ (1 << 63)).to_be_bytes().to_vec();
    key.extend_from_slice(id.as_bytes());
    key
}

/// Every key in one named database, through the public environment handle.
fn database_entries(backend: &LmdbBackend, name: &str) -> Vec<(Vec<u8>, Vec<u8>)> {
    let txn = backend.env().read_txn().expect("a read transaction");
    let database = backend
        .env()
        .open_database::<Bytes, Bytes>(&txn, Some(name))
        .expect("the database opens")
        .expect("the database exists");
    database
        .iter(&txn)
        .expect("the database iterates")
        .map(|entry| {
            let (key, value) = entry.expect("a stored entry");
            (key.to_vec(), value.to_vec())
        })
        .collect()
}

fn database_keys(backend: &LmdbBackend, name: &str) -> Vec<Vec<u8>> {
    database_entries(backend, name)
        .into_iter()
        .map(|(key, _)| key)
        .collect()
}

/// Pages one table of the store to its end.
async fn scan_all(target: &dyn MigrationTarget, table: MigratedTable) -> Vec<MigrationRow> {
    let mut rows = Vec::new();
    let mut after: Option<Vec<u8>> = None;
    loop {
        let page = target
            .scan_batch(table, after.as_deref(), 100)
            .await
            .expect("the store scans");
        let count = page.len();
        if let Some(last) = page.last() {
            after = Some(last.key());
        }
        rows.extend(page);
        if count < 100 {
            return rows;
        }
    }
}

// ---------------------------------------------------------------------------------------
// AC2: the whole copy, and a second run that verifies.
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_clean_run_copies_every_table_and_a_second_run_writes_nothing() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");
    let source = StubSource::new(source_rows());
    let options = options(directory.path(), 1_000);

    let mut out = Vec::new();
    let output = migrate::migrate_with(&source, &target, &options, &mut out)
        .await
        .expect("the copy runs");
    assert_eq!(output.exit_code, 0);

    let written = manifest(directory.path());
    assert_eq!(written["format"], 1);
    assert_eq!(
        written["not_migrated"],
        json!(["event_tags", "user_subscriptions"])
    );
    let tables = written["tables"]
        .as_object()
        .expect("the manifest names tables");
    assert_eq!(tables.len(), 9, "one entry per migrated table");
    for table in MigratedTable::ALL {
        let entry = &tables[table.name()];
        assert_eq!(entry["rows"], 3, "{} rows", table.name());
        assert_eq!(entry["complete"], true, "{} is complete", table.name());
    }

    // Each table scans to exactly the source's rows.
    for table in MigratedTable::ALL {
        assert_eq!(
            scan_all(&target, table).await,
            rows_of(&source_rows(), table),
            "{} scans to the source's rows",
            table.name()
        );
    }

    // One row per table read back through that table's own read.
    let filters = [Filter {
        limit: Some(10),
        ..Filter::default()
    }];
    let events = collect_records(
        EventRepository::find_by_filters(&target, &filters)
            .await
            .expect("the filter read opens"),
    )
    .await
    .expect("the filter read drains");
    assert_eq!(events.len(), 3);
    for seed in 1..=3 {
        assert!(
            events.contains(&event_record(seed, "hello")),
            "event {seed} reads back"
        );
    }

    assert_eq!(
        UserRepository::find_by_pubkey(&target, &pubkey(31))
            .await
            .expect("the user reads")
            .expect("the user is stored"),
        user(1).user
    );
    assert_eq!(
        InvoiceRepository::find_by_id(&target, &invoice(1).id)
            .await
            .expect("the invoice reads")
            .expect("the invoice is stored"),
        invoice(1)
    );
    assert_eq!(
        InvoiceRepository::find_pending_invoices(&target, 0, 10)
            .await
            .expect("the pending index reads"),
        vec![invoice(3)]
    );
    assert_eq!(
        Nip05VerificationRepository::find_by_pubkey(&target, &nip05(1).pubkey)
            .await
            .expect("the verification reads"),
        Some(nip05(1))
    );
    assert_eq!(
        InviteCodeRepository::find_by_code(&target, &invite(1).code)
            .await
            .expect("the code reads"),
        Some(invite(1))
    );
    assert_eq!(
        DvmJobRepository::find_by_id(&target, &dvm_job(1).id)
            .await
            .expect("the job reads"),
        Some(dvm_job(1))
    );
    assert_eq!(
        ReportRepository::find_by_event_id(&target, &report(1).event_id)
            .await
            .expect("the report reads"),
        vec![report(1)]
    );
    let mut logged: Vec<String> =
        NotificationDeliveryLogRepository::find_recent(&target, 10, &DeliveryLogFilters::default())
            .await
            .expect("the log reads")
            .into_iter()
            .map(|entry| entry.id)
            .collect();
    logged.sort();
    assert_eq!(
        logged,
        vec![delivery_log(1).id, delivery_log(2).id, delivery_log(3).id]
    );

    // The second run: a source that would answer rows and counts its calls.
    let counting = StubSource::new(Vec::new());
    let before = manifest_bytes(directory.path());
    let usage = target
        .map_usage()
        .await
        .expect("the usage reads")
        .used_bytes;
    let mut out = Vec::new();
    let output = migrate::migrate_with(&counting, &target, &options, &mut out)
        .await
        .expect("the second run succeeds");
    assert_eq!(output.exit_code, 0);
    assert_eq!(
        counting.calls().len(),
        0,
        "the second run never asked the source for a row"
    );
    assert_eq!(
        manifest_bytes(directory.path()),
        before,
        "the manifest is unchanged"
    );
    for table in MigratedTable::ALL {
        assert_eq!(
            scan_all(&target, table).await.len(),
            3,
            "{} still holds three rows",
            table.name()
        );
    }
    assert_eq!(
        target
            .map_usage()
            .await
            .expect("the usage reads")
            .used_bytes,
        usage,
        "the store was not written"
    );
    assert!(
        output_text(out).contains("Verified 9 tables"),
        "the second run verified rather than short-circuiting"
    );

    // The one read that writes is made after that second run, because it would move a checksum.
    let created = ReportRepository::create(
        &target,
        &NewReport {
            event_id: event_id(1),
            reporter_pubkey: pubkey(2),
            reported_pubkey: None,
            reported_event_id: None,
            report_type: ReportType::Spam,
            weight: 1.0,
            actionable: true,
        },
    )
    .await
    .expect("a report is created");
    assert_eq!(created.id, 4, "the migrated ids raised the sequence");
}

// ---------------------------------------------------------------------------------------
// AC3: resume.
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn an_interrupted_run_resumes_to_the_clean_run_manifest() {
    // The clean run over source S at --batch-size 1.
    let clean_directory = tempfile::tempdir().expect("a temporary directory");
    let clean_target = LmdbBackend::open(clean_directory.path())
        .await
        .expect("the store opens");
    let clean_options = options(clean_directory.path(), 1);
    migrate::migrate_with(
        &StubSource::new(source_rows()),
        &clean_target,
        &clean_options,
        &mut Vec::new(),
    )
    .await
    .expect("the clean run succeeds");
    let clean = manifest_bytes(clean_directory.path());

    // The interrupted run: the second read_batch answers Err.
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");
    let options = options(directory.path(), 1);
    let failing = StubSource::failing_at(source_rows(), 1);
    let error = migrate::migrate_with(&failing, &target, &options, &mut Vec::new())
        .await
        .expect_err("the second read fails");
    assert!(
        matches!(error, nostream_cli::CliError::Migrate(_)),
        "a migration failure is the variant `main` prints as `Migration failed:` and exits 1 for"
    );
    assert_eq!(
        error.to_string(),
        "dvm_jobs: invalid argument: the stub's read failed"
    );

    let interrupted = manifest(directory.path());
    let dvm = &interrupted["tables"]["dvm_jobs"];
    assert_eq!(dvm["rows"], 1);
    assert_eq!(dvm["complete"], false);
    let first_key = dvm_job(1).id.as_bytes().to_vec();
    assert_eq!(dvm["after"], hex::encode(&first_key));

    // The healthy source over the same target, at --batch-size 1 too.
    let resumed = StubSource::new(source_rows());
    let mut out = Vec::new();
    let output = migrate::migrate_with(&resumed, &target, &options, &mut out)
        .await
        .expect("the resumed run succeeds");
    let calls = resumed.calls();

    // 1. The run measured the resume rather than restarting the table.
    assert_eq!(calls[0].0, MigratedTable::DvmJobs);
    assert_eq!(
        calls[0].1,
        Some(first_key),
        "the first call resumes at the manifest's cursor"
    );
    // 2. The cursor advances per batch.
    assert_eq!(calls[1].0, MigratedTable::DvmJobs);
    assert_eq!(calls[1].1, Some(dvm_job(2).id.as_bytes().to_vec()));

    // 3. The resumed run lands on the clean run's manifest, byte for byte.
    assert_eq!(output.exit_code, 0);
    assert_eq!(manifest_bytes(directory.path()), clean);
}

// ---------------------------------------------------------------------------------------
// AC4: one changed column moves only its table's checksum.
// ---------------------------------------------------------------------------------------

/// Copies `rows` into a fresh store and answers its manifest.
async fn manifest_of(rows: Vec<MigrationRow>) -> Value {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");
    migrate::migrate_with(
        &StubSource::new(rows),
        &target,
        &options(directory.path(), 1_000),
        &mut Vec::new(),
    )
    .await
    .expect("the copy succeeds");
    manifest(directory.path())
}

#[tokio::test]
async fn one_changed_source_row_changes_only_its_table_checksum() {
    let clean = manifest_of(source_rows()).await;

    let mut richer = source_rows();
    for row in &mut richer {
        if let MigrationRow::User(migrated) = row
            && migrated.user.pubkey == user(1).user.pubkey
        {
            migrated.user.balance = 999;
        }
    }
    let balance = manifest_of(richer).await;

    let mut accepted = source_rows();
    for row in &mut accepted {
        if let MigrationRow::User(migrated) = row
            && migrated.user.pubkey == user(1).user.pubkey
        {
            migrated.tos_accepted_at = Some(at(7));
        }
    }
    let tos = manifest_of(accepted).await;

    for variant in [&balance, &tos] {
        assert_eq!(
            variant["tables"]["users"]["rows"],
            clean["tables"]["users"]["rows"]
        );
        assert_ne!(
            variant["tables"]["users"]["checksum"],
            clean["tables"]["users"]["checksum"]
        );
        for table in MigratedTable::ALL {
            if table == MigratedTable::Users {
                continue;
            }
            assert_eq!(
                variant["tables"][table.name()]["checksum"],
                clean["tables"][table.name()]["checksum"],
                "{} is unchanged",
                table.name()
            );
        }
    }
}

// ---------------------------------------------------------------------------------------
// AC5: verify pages the whole table.
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn verify_accepts_the_runs_own_target_and_rejects_a_changed_row() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");
    let rows: Vec<MigrationRow> = (1..=5)
        .map(|seed| MigrationRow::Event(event_record(seed, "hello")))
        .collect();
    // Five events at --batch-size 2 is three pages, so a verify that reads one page sees two.
    let options = options(directory.path(), 2);
    migrate::migrate_with(&StubSource::new(rows), &target, &options, &mut Vec::new())
        .await
        .expect("the copy succeeds");

    let before = target
        .map_usage()
        .await
        .expect("the usage reads")
        .used_bytes;
    let mut out = Vec::new();
    let output = migrate::verify_with(&target, &options, &mut out)
        .await
        .expect("the verify runs");
    assert_eq!(output.exit_code, 0);
    assert!(output_text(out).contains("Verified 9 tables"));

    // A same-length content change under the same key: the count cannot move.
    let mut changed = event_record(1, "hello");
    changed.event.content = "jello".to_owned();
    target
        .write_batch(&[MigrationRow::Event(changed)])
        .await
        .expect("the changed row is written");

    let mut out = Vec::new();
    let output = migrate::verify_with(&target, &options, &mut out)
        .await
        .expect("the verify runs");
    assert_eq!(output.exit_code, 1);
    let text = output_text(out);
    let line = text
        .lines()
        .find(|line| line.starts_with("[events] checksum mismatch (manifest "))
        .unwrap_or_else(|| panic!("a checksum line is printed, got:\n{text}"));
    let body = line
        .strip_prefix("[events] checksum mismatch (manifest ")
        .expect("the line's prefix")
        .trim_end_matches(')');
    let (manifest_hex, target_hex) = body.split_once(", target ").expect("both checksums");
    assert_eq!(manifest_hex.len(), 64, "the manifest's checksum: {line}");
    assert_eq!(target_hex.len(), 64, "the target's checksum: {line}");

    assert_eq!(
        target
            .map_usage()
            .await
            .expect("the usage reads")
            .used_bytes,
        before,
        "verify wrote nothing to the store"
    );
}

// ---------------------------------------------------------------------------------------
// AC6: no manifest.
// ---------------------------------------------------------------------------------------

/// The directory's entries with their kind, sorted by name: what a verify must leave as it found
/// it.
fn entries(path: &std::path::Path) -> Vec<(String, bool)> {
    let mut entries: Vec<(String, bool)> = std::fs::read_dir(path)
        .expect("the directory reads")
        .map(|entry| {
            let entry = entry.expect("an entry reads");
            (
                entry.file_name().to_string_lossy().into_owned(),
                entry.file_type().expect("the entry's type").is_dir(),
            )
        })
        .collect();
    entries.sort();
    entries
}

// `run` builds a runtime of its own, so this test cannot be a `#[tokio::test]`: the async half
// is driven by a runtime this test owns, and the two `run` calls happen outside any `block_on`.
#[test]
fn verify_creates_nothing_and_rejects_a_target_with_no_store_or_no_manifest() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("the test runtime builds");
    let directory = tempfile::tempdir().expect("a temporary directory");

    // Half one: a target with no store. The listing is the same afterwards.
    let before = entries(directory.path());
    let mut out = Vec::new();
    let output = migrate::run(
        MigrateOptions {
            verify: true,
            ..options(directory.path(), 1_000)
        },
        &mut out,
    )
    .expect("a missing store is an answer, not a failure");
    assert_eq!(output.exit_code, 1);
    let text = output_text(out);
    assert!(text.contains("No store at"), "got: {text}");
    assert!(
        text.contains(&directory.path().join("lmdb").display().to_string()),
        "the line names the store it looked for: {text}"
    );
    assert_eq!(entries(directory.path()), before, "verify created nothing");

    // Half two: a store a copy filled, and whose manifest has since been removed.
    let copy = options(directory.path(), 1_000);
    let (usage, counts) = runtime.block_on(async {
        let target = LmdbBackend::open(directory.path())
            .await
            .expect("the store opens");
        migrate::migrate_with(
            &StubSource::new(source_rows()),
            &target,
            &copy,
            &mut Vec::new(),
        )
        .await
        .expect("the copy succeeds");
        let usage = target
            .map_usage()
            .await
            .expect("the usage reads")
            .used_bytes;
        let mut counts = Vec::new();
        for table in MigratedTable::ALL {
            counts.push(scan_all(&target, table).await.len());
        }
        (usage, counts)
    });
    std::fs::remove_file(directory.path().join("migration-manifest.json"))
        .expect("the manifest is removed");

    let mut out = Vec::new();
    let output = migrate::run(
        MigrateOptions {
            verify: true,
            ..options(directory.path(), 1_000)
        },
        &mut out,
    )
    .expect("a missing manifest is an answer, not a failure");
    assert_eq!(output.exit_code, 1);
    let text = output_text(out);
    assert!(text.contains("No manifest at"), "got: {text}");
    assert!(
        text.contains(
            &directory
                .path()
                .join("migration-manifest.json")
                .display()
                .to_string()
        ),
        "the line names the manifest it looked for: {text}"
    );

    runtime.block_on(async {
        let reopened = LmdbBackend::open(directory.path())
            .await
            .expect("the store reopens");
        for (table, count) in MigratedTable::ALL.iter().zip(counts) {
            assert_eq!(
                scan_all(&reopened, *table).await.len(),
                count,
                "{} is unchanged",
                table.name()
            );
        }
        assert_eq!(
            reopened
                .map_usage()
                .await
                .expect("the usage reads")
                .used_bytes,
            usage,
            "the store's bytes are unchanged"
        );
    });
}

// ---------------------------------------------------------------------------------------
// AC17: a crash between the first batch's commit and its manifest write.
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_crash_between_the_first_batch_and_the_manifest_write_resumes_to_the_clean_manifest() {
    let table = MigratedTable::ALL[0];

    // The uninterrupted run: the manifest and the counts a resume has to land on.
    let clean = tempfile::tempdir().expect("a temporary directory");
    let clean_store = LmdbBackend::open(clean.path())
        .await
        .expect("the store opens");
    migrate::migrate_with(
        &StubSource::new(source_rows()),
        &clean_store,
        &options(clean.path(), 1_000),
        &mut Vec::new(),
    )
    .await
    .expect("the clean copy succeeds");
    let clean_manifest = manifest_bytes(clean.path());
    let mut clean_counts = Vec::new();
    for table in MigratedTable::ALL {
        clean_counts.push(scan_all(&clean_store, table).await.len());
    }
    drop(clean_store);

    // The crash state, reproduced rather than killed: the fresh manifest R6 writes before its
    // first batch, then that batch's rows, and nothing else. A source that fails on its first
    // read leaves exactly that manifest behind, and its entries are asserted below.
    let crashed = tempfile::tempdir().expect("a temporary directory");
    let store = LmdbBackend::open(crashed.path())
        .await
        .expect("the store opens");
    let options = options(crashed.path(), 1_000);
    let error = migrate::migrate_with(
        &StubSource::failing_at(source_rows(), 0),
        &store,
        &options,
        &mut Vec::new(),
    )
    .await
    .expect_err("the first read fails");
    assert!(
        matches!(error, nostream_cli::CliError::Migrate(_)),
        "a source failure is the variant `main` reports as `Migration failed:`"
    );

    let fresh = manifest_bytes(crashed.path());
    let fresh: Value = serde_json::from_slice(&fresh).expect("the fresh manifest is json");
    assert_eq!(fresh["format"], 1);
    assert_eq!(
        fresh["not_migrated"],
        json!(["event_tags", "user_subscriptions"])
    );
    let tables = fresh["tables"].as_object().expect("the tables object");
    assert_eq!(tables.len(), 9, "one entry per table");
    for entry in tables.values() {
        assert_eq!(entry["rows"], 0);
        assert_eq!(entry["checksum"], "0".repeat(64));
        assert_eq!(entry["after"], "");
        assert_eq!(entry["complete"], false);
    }

    let source = StubSource::new(source_rows());
    let first = MigrationSource::read_batch(&source, table, None, 200)
        .await
        .expect("the first batch reads");
    assert!(!first.is_empty(), "the first table has rows");
    store
        .write_batch(&first)
        .await
        .expect("the first batch is stored");

    // The resume replays that batch from the fresh manifest's own cursor.
    let resumed = StubSource::new(source_rows());
    let output = migrate::migrate_with(&resumed, &store, &options, &mut Vec::new())
        .await
        .expect("the resume succeeds");
    assert_eq!(output.exit_code, 0);
    assert_eq!(
        resumed.calls().first(),
        Some(&(table, None)),
        "the resume starts at the fresh manifest's empty cursor"
    );
    for (table, count) in MigratedTable::ALL.iter().zip(clean_counts) {
        assert_eq!(
            scan_all(&store, *table).await.len(),
            count,
            "{} count",
            table.name()
        );
    }
    assert_eq!(
        manifest_bytes(crashed.path()),
        clean_manifest,
        "the resume lands on the uninterrupted run's manifest"
    );
}

// ---------------------------------------------------------------------------------------
// AC7: the run's own measurement.
// ---------------------------------------------------------------------------------------

/// One event whose id is its index, so a thousand of them are a thousand keys in key order.
fn indexed_event(index: u64) -> MigrationRow {
    let mut record = event_record(1, "hello");
    let mut id = [0u8; 32];
    id[..8].copy_from_slice(&index.to_be_bytes());
    record.event.id = EventId::from_byte_array(id);
    MigrationRow::Event(record)
}

/// The two summary lines, parsed.
fn summary(text: &str) -> (u64, u64, u64, String) {
    let mut lines = text.lines();
    let first = lines.next().expect("the rows line");
    let second = lines.next().expect("the throughput line");
    let third = lines.next().expect("the store line");
    assert_eq!(lines.next(), None, "exactly three summary lines");

    let (rows_text, rest) = first
        .strip_prefix("Migrated ")
        .and_then(|rest| rest.split_once(" rows in "))
        .expect("the rows line's shape");
    let ms_text = rest.strip_suffix(" ms").expect("the milliseconds");
    let rate_text = second
        .strip_prefix("Events throughput: ")
        .and_then(|rest| rest.strip_suffix(" events/s"))
        .expect("the throughput line's shape");

    let store = third
        .strip_prefix("Store: ")
        .expect("the store line's shape")
        .to_owned();

    (
        rows_text.parse().expect("a row count"),
        ms_text.parse().expect("a millisecond count"),
        rate_text.parse().expect("a rate"),
        store,
    )
}

/// A target that sleeps inside every batch it writes, so the run has work its own clock cannot
/// miss: five batches of 200 rows pay at least 100 ms.
struct SleepingTarget {
    inner: LmdbBackend,
}

impl MigrationTarget for SleepingTarget {
    fn write_batch<'a>(&'a self, rows: &'a [MigrationRow]) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            MigrationTarget::write_batch(&self.inner, rows).await
        })
    }

    fn scan_batch<'a>(
        &'a self,
        table: MigratedTable,
        after: Option<&'a [u8]>,
        limit: usize,
    ) -> StorageFuture<'a, Vec<MigrationRow>> {
        MigrationTarget::scan_batch(&self.inner, table, after, limit)
    }
}

#[tokio::test]
async fn the_run_prints_a_rate_consistent_with_its_own_events_and_milliseconds() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let store = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");
    let target = SleepingTarget { inner: store };
    // 1 000 events at --batch-size 200 is five full batches plus the closing short read, and the
    // target sleeps 20 ms in each, so the copy cannot finish in less than 100 ms.
    let rows: Vec<MigrationRow> = (0..1_000).map(indexed_event).collect();
    let options = options(directory.path(), 200);

    let mut out = Vec::new();
    migrate::migrate_with(&StubSource::new(rows), &target, &options, &mut out)
        .await
        .expect("the copy succeeds");
    let (rows, ms, rate, store) = summary(&output_text(out));
    assert_eq!(
        store,
        std::fs::canonicalize(directory.path().join("lmdb"))
            .expect("the store exists")
            .display()
            .to_string(),
        "the summary names the canonical store the copy landed in"
    );

    assert_eq!(rows, 1_000);
    assert!(
        ms >= 100,
        "the run's clock includes the 100 ms the target slept: printed {ms} ms"
    );
    assert_eq!(
        rate,
        1_000 * 1_000 / ms.max(1),
        "the rate is the printed numbers'"
    );
    assert!(rate > 0);
}

// ---------------------------------------------------------------------------------------
// AC8: a migrated event keeps what the traits would lose.
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_migrated_event_keeps_first_seen_deduplication_and_its_deleted_state() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");

    let mut live = event_record(1, "live");
    live.first_seen = Some(instant("2020-01-01T00:00:00Z"));
    live.remote_address = Some("203.0.113.7".parse().expect("a fixture address"));
    live.event_deduplication = Some(vec![json!("abc")]);
    live.expires_at = Some(1_893_456_000);

    let mut deleted = event_record(2, "deleted");
    deleted.deleted_at = Some(at(500));

    let mut expired = event_record(3, "expired");
    expired.expires_at = Some(1_577_836_800);

    let rows = vec![
        MigrationRow::Event(live.clone()),
        MigrationRow::Event(deleted.clone()),
        MigrationRow::Event(expired.clone()),
    ];
    migrate::migrate_with(
        &StubSource::new(rows.clone()),
        &target,
        &options(directory.path(), 1_000),
        &mut Vec::new(),
    )
    .await
    .expect("the copy succeeds");

    assert_eq!(
        scan_all(&target, MigratedTable::Events).await,
        rows_of(&rows, MigratedTable::Events)
    );

    // The criterion's split is the store's own: `lmdb/events.rs:775-807` builds a filter page with
    // `live: false`, so a soft-deleted or expired row is readable by filter, and
    // `count_by_filters` is the read that applies the live predicate (ADR 0011 D4, pinned by
    // `parity_lmdb::a_soft_deleted_event_is_readable_by_filter_and_excluded_from_count`). The
    // count is the half that proves B and C are stored *and* marked.
    //
    // A copy that read its **source** through `find_by_filters` would lose B and C instead: the
    // Postgres composer adds `deleted_at IS NULL AND (expires_at IS NULL OR expires_at > $now)`
    // (`postgres/sql.rs:265`), which is why the seam's reader has no filter at all.
    let filters = [Filter {
        limit: Some(10),
        ..Filter::default()
    }];
    let read = collect_records(
        EventRepository::find_by_filters(&target, &filters)
            .await
            .expect("the filter read opens"),
    )
    .await
    .expect("the filter read drains");
    assert_eq!(read.len(), 3, "every stored row reads back by filter");
    let live_read = read
        .iter()
        .find(|record| record.event.id == live.event.id)
        .expect("the live row reads back");
    assert_eq!(live_read.first_seen, live.first_seen);
    assert_eq!(live_read.remote_address, live.remote_address);
    assert_eq!(live_read.event_deduplication, live.event_deduplication);
    assert_eq!(live_read.expires_at, live.expires_at);
    let deleted_read = read
        .iter()
        .find(|record| record.event.id == deleted.event.id)
        .expect("the soft-deleted row reads back");
    assert_eq!(deleted_read.deleted_at, deleted.deleted_at);
    let expired_read = read
        .iter()
        .find(|record| record.event.id == expired.event.id)
        .expect("the expired row reads back");
    assert_eq!(expired_read.expires_at, expired.expires_at);
    assert_eq!(
        EventRepository::count_by_filters(&target, &filters)
            .await
            .expect("the count runs"),
        1,
        "the live predicate holds for the count, so only the live row is counted"
    );

    // Both tail indexes are stated separately: a value-only copy passes every read above.
    let deleted_at = deleted.deleted_at.expect("the fixture is deleted");
    assert_eq!(
        database_keys(&target, "events_deleted"),
        vec![time_key(deleted_at.timestamp(), deleted.event.id)],
        "one entry, keyed by the deleted instant in whole seconds"
    );

    let mut expiring = database_keys(&target, "events_expiring");
    let mut expected = vec![
        time_key(
            live.expires_at.expect("the live row expires"),
            live.event.id,
        ),
        time_key(
            expired.expires_at.expect("the expired row expires"),
            expired.event.id,
        ),
    ];
    expiring.sort();
    expected.sort();
    assert_eq!(expiring, expected);
}

// ---------------------------------------------------------------------------------------
// AC9: a refused row stops the run.
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_refused_row_stops_the_run_and_keeps_the_resume_point() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");

    /// A tag whose key is past LMDB's 511-byte bound: `2 + 601 + 8 + 32` bytes.
    fn refused(seed: u8) -> EventRecord {
        let mut record = event_record(seed, "refused");
        record.event.tags = vec![vec!["t".to_owned(), "a".repeat(600)]];
        record
    }

    let rows: Vec<MigrationRow> = (1..=2)
        .map(|seed| MigrationRow::Event(event_record(seed, "fine")))
        .chain(std::iter::once(MigrationRow::Event(refused(3))))
        .collect();
    // The refused row is in the second batch of two.
    let options = options(directory.path(), 2);
    let error = migrate::migrate_with(&StubSource::new(rows), &target, &options, &mut Vec::new())
        .await
        .expect_err("the refused key fails the batch");
    assert!(
        matches!(error, nostream_cli::CliError::Migrate(_)),
        "a migration failure is the variant `main` prints as `Migration failed:` and exits 1 for"
    );
    assert!(
        error.to_string().starts_with("events: "),
        "the message names the table whose write failed, not a batch ordinal: {error}"
    );

    let written = manifest(directory.path());
    let events = &written["tables"]["events"];
    assert_eq!(events["complete"], false);
    assert_eq!(events["rows"], 2);
    assert_eq!(
        events["after"],
        hex::encode(event_record(2, "fine").event.id.as_bytes())
    );
    assert_eq!(
        scan_all(&target, MigratedTable::Events).await.len(),
        2,
        "the first batch is the store's content"
    );

    // The resume point is usable: a healthy source continues where the refused row stopped.
    let resumed = StubSource::new(vec![MigrationRow::Event(event_record(3, "fine"))]);
    let output = migrate::migrate_with(&resumed, &target, &options, &mut Vec::new())
        .await
        .expect("the run resumes after the refusal");
    assert_eq!(output.exit_code, 0);
    assert_eq!(resumed.calls()[0].0, MigratedTable::Events);
    assert_eq!(
        resumed.calls()[0].1,
        Some(event_record(2, "fine").event.id.as_bytes().to_vec())
    );
}

// ---------------------------------------------------------------------------------------
// AC16: a target that already holds rows and carries no manifest.
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_target_with_rows_and_no_manifest_is_refused() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");

    // Three rows in one table, through the seam's own write, and no manifest anywhere.
    let seeded: Vec<MigrationRow> = (1..=3)
        .map(|seed| MigrationRow::Event(event_record(seed, "seeded")))
        .collect();
    assert_eq!(
        target.write_batch(&seeded).await.expect("the seed writes"),
        3
    );
    let manifest = directory.path().join("migration-manifest.json");
    assert!(!manifest.exists(), "the seed writes no manifest");

    let source = StubSource::new(source_rows());
    let error = migrate::migrate_with(
        &source,
        &target,
        &options(directory.path(), 1_000),
        &mut Vec::new(),
    )
    .await
    .expect_err("a target with rows and no manifest is refused");
    assert!(
        matches!(error, nostream_cli::CliError::Migrate(_)),
        "a migration failure is the variant `main` prints as `Migration failed:` and exits 1 for"
    );
    let message = error.to_string();
    assert!(message.contains("already holds rows"), "{message}");
    assert!(
        message.contains(&directory.path().display().to_string()),
        "the message names the target: {message}"
    );
    assert_eq!(source.calls().len(), 0, "nothing was read");
    assert_eq!(
        scan_all(&target, MigratedTable::Events).await.len(),
        3,
        "the seeded rows are untouched"
    );
    for table in MigratedTable::ALL {
        if table == MigratedTable::Events {
            continue;
        }
        assert_eq!(
            scan_all(&target, table).await.len(),
            0,
            "{} is untouched",
            table.name()
        );
    }
    assert!(!manifest.exists(), "no manifest was written");

    // The control: the same source into an empty directory proceeds.
    let empty = tempfile::tempdir().expect("a temporary directory");
    let clean = LmdbBackend::open(empty.path())
        .await
        .expect("the store opens");
    let output = migrate::migrate_with(
        &StubSource::new(source_rows()),
        &clean,
        &options(empty.path(), 1_000),
        &mut Vec::new(),
    )
    .await
    .expect("an empty target proceeds");
    assert_eq!(output.exit_code, 0);
    assert!(
        empty.path().join("migration-manifest.json").exists(),
        "the control run wrote its manifest"
    );
}

// ---------------------------------------------------------------------------------------
// A manifest of another format, a batch of zero, and a verify with no store.
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_manifest_of_another_format_is_refused_before_anything_is_written() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");
    std::fs::write(
        directory.path().join("migration-manifest.json"),
        br#"{"format":2,"not_migrated":[],"tables":{}}"#,
    )
    .expect("the fixture manifest is written");
    let usage = target
        .map_usage()
        .await
        .expect("the usage reads")
        .used_bytes;

    let source = StubSource::new(source_rows());
    let error = migrate::migrate_with(
        &source,
        &target,
        &options(directory.path(), 1_000),
        &mut Vec::new(),
    )
    .await
    .expect_err("format 2 is refused");
    let message = error.to_string();
    assert!(message.contains("migration-manifest.json"), "{message}");
    assert!(message.contains("format 2"), "{message}");
    assert_eq!(source.calls().len(), 0, "nothing was read");
    assert_eq!(
        target
            .map_usage()
            .await
            .expect("the usage reads")
            .used_bytes,
        usage,
        "nothing was written"
    );

    let error = migrate::verify_with(&target, &options(directory.path(), 1_000), &mut Vec::new())
        .await
        .expect_err("format 2 is refused by verify too");
    assert!(error.to_string().contains("format 2"), "{error}");
}

#[tokio::test]
async fn a_manifest_that_does_not_name_the_nine_tables_is_refused() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");
    // A store with three rows already in it: a partial manifest must not let a copy restart
    // every table at `rows: 0` over them, which is what R7's refusal exists to prevent.
    let seeded: Vec<MigrationRow> = (1..=3)
        .map(|seed| MigrationRow::Event(event_record(seed, "seeded")))
        .collect();
    assert_eq!(
        target.write_batch(&seeded).await.expect("the seed writes"),
        3
    );
    let manifest = directory.path().join("migration-manifest.json");

    std::fs::write(&manifest, br#"{"format":1,"not_migrated":[],"tables":{}}"#)
        .expect("the fixture manifest is written");
    let source = StubSource::new(source_rows());
    let error = migrate::migrate_with(
        &source,
        &target,
        &options(directory.path(), 1_000),
        &mut Vec::new(),
    )
    .await
    .expect_err("a manifest that names no tables is refused");
    let message = error.to_string();
    assert!(message.contains("nine tables"), "got: {message}");
    for table in MigratedTable::ALL {
        assert!(
            message.contains(table.name()),
            "the refusal names {}: {message}",
            table.name()
        );
    }
    assert_eq!(source.calls().len(), 0, "nothing was read");
    assert_eq!(
        scan_all(&target, MigratedTable::Events).await.len(),
        3,
        "the seeded rows are untouched"
    );

    // The nine tables, and a `not_migrated` that is not this tool's.
    let mut tables = serde_json::Map::new();
    for table in MigratedTable::ALL {
        tables.insert(
            table.name().to_owned(),
            json!({"rows": 0, "checksum": "0".repeat(64), "after": "", "complete": false}),
        );
    }
    let fixture = json!({"format": 1, "not_migrated": ["event_tags"], "tables": tables});
    std::fs::write(
        &manifest,
        serde_json::to_vec(&fixture).expect("the fixture serialises"),
    )
    .expect("the fixture manifest is written");
    let error = migrate::migrate_with(
        &StubSource::new(source_rows()),
        &target,
        &options(directory.path(), 1_000),
        &mut Vec::new(),
    )
    .await
    .expect_err("the wrong not_migrated list is refused");
    assert!(error.to_string().contains("not_migrated"), "{error}");
    assert_eq!(
        scan_all(&target, MigratedTable::Events).await.len(),
        3,
        "the seeded rows are untouched"
    );

    // Nine names, one of them swapped for a name that is not a table. A check that counted the
    // entries would accept this, so the refusal has to be about which names they are.
    let mut tables = serde_json::Map::new();
    for table in MigratedTable::ALL.iter().skip(1) {
        tables.insert(
            table.name().to_owned(),
            json!({"rows": 0, "checksum": "0".repeat(64), "after": "", "complete": false}),
        );
    }
    tables.insert(
        "not_a_table".to_owned(),
        json!({"rows": 0, "checksum": "0".repeat(64), "after": "", "complete": false}),
    );
    let fixture =
        json!({"format": 1, "not_migrated": MigratedTable::NOT_MIGRATED, "tables": tables});
    std::fs::write(
        &manifest,
        serde_json::to_vec(&fixture).expect("the fixture serialises"),
    )
    .expect("the fixture manifest is written");
    let error = migrate::migrate_with(
        &StubSource::new(source_rows()),
        &target,
        &options(directory.path(), 1_000),
        &mut Vec::new(),
    )
    .await
    .expect_err("one swapped name is refused even though the count is right");
    let message = error.to_string();
    assert!(message.contains("not_a_table"), "{message}");
    assert!(
        message.contains(MigratedTable::ALL[0].name()),
        "the refusal names the table that is missing: {message}"
    );
}

#[tokio::test]
async fn a_zero_batch_is_refused_instead_of_looping() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");

    let source = StubSource::new(source_rows());
    let error = migrate::migrate_with(
        &source,
        &target,
        &options(directory.path(), 0),
        &mut Vec::new(),
    )
    .await
    .expect_err("a batch of zero is refused");
    assert!(error.to_string().contains("--batch-size"), "{error}");
    assert_eq!(source.calls().len(), 0, "nothing was read");

    let error = migrate::verify_with(&target, &options(directory.path(), 0), &mut Vec::new())
        .await
        .expect_err("a batch of zero is refused by verify too");
    assert!(error.to_string().contains("--batch-size"), "{error}");
}

#[test]
fn verify_refuses_a_manifest_without_a_store_instead_of_creating_one() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    write_manifest_fixture(directory.path(), true);
    let store = directory.path().join("lmdb");

    for verify in [true, false] {
        let mut out = Vec::new();
        let output = migrate::run(
            MigrateOptions {
                verify,
                ..options(directory.path(), 1_000)
            },
            &mut out,
        )
        .expect("a missing store is an answer, not a failure");
        assert_eq!(output.exit_code, 1);
        let text = output_text(out);
        assert!(text.contains("No store at"), "{text}");
        assert!(
            text.contains(&store.display().to_string()),
            "the line names the store: {text}"
        );
        assert!(
            !store.exists(),
            "verify created no store (verify = {verify})"
        );
    }
}

// ---------------------------------------------------------------------------------------
// The seam's index writes, asserted where the store keeps them.
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_migrated_replaceable_event_writes_the_pointer_its_kind_index_is_keyed_by() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");

    let mut record = event_record(7, "the first value");
    record.event.kind = Kind(10000);
    // A stored, empty deduplication list: the author and kind alone, with no `d` element.
    record.event_deduplication = Some(Vec::new());
    target
        .write_batch(&[MigrationRow::Event(record.clone())])
        .await
        .expect("the event writes");

    let entries = database_entries(&target, "replaceable");
    assert_eq!(entries.len(), 1, "one pointer for the author and kind");
    let (key, value) = &entries[0];
    assert_eq!(
        value.as_slice(),
        record.event.id.as_bytes(),
        "the pointer carries the event id"
    );
    assert_eq!(
        key.len(),
        36,
        "pubkey ++ kind, with no deduplication element"
    );
    assert_eq!(&key[..32], record.event.pubkey.as_bytes());

    // A second event of the same author and kind replaces the pointer at the same key, so the
    // key is the author and kind rather than the id.
    let mut second = record.clone();
    second.event.id = event_id(9);
    target
        .write_batch(&[MigrationRow::Event(second.clone())])
        .await
        .expect("the replacement writes");
    let entries = database_entries(&target, "replaceable");
    assert_eq!(entries.len(), 1, "one pointer per author and kind");
    assert_eq!(entries[0].0, *key, "the same key");
    assert_eq!(entries[0].1.as_slice(), second.event.id.as_bytes());
}

#[tokio::test]
async fn a_migrated_delivery_without_an_outbox_id_stores_no_outbox_pointer() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");

    let mut orphan = delivery_log(1);
    orphan.outbox_id = None;
    let linked = delivery_log(2);
    target
        .write_batch(&[
            MigrationRow::DeliveryLogEntry(orphan.clone()),
            MigrationRow::DeliveryLogEntry(linked.clone()),
        ])
        .await
        .expect("the rows write");

    let rows = scan_all(&target, MigratedTable::NotificationDeliveryLog).await;
    let stored = rows
        .iter()
        .find_map(|row| match row {
            MigrationRow::DeliveryLogEntry(entry) if entry.id == orphan.id => Some(entry),
            _ => None,
        })
        .expect("the row without an outbox id is stored");
    assert_eq!(stored.outbox_id, None, "the NULL outbox id survives");
    assert_eq!(stored.event_type, orphan.event_type);

    let pointers = database_entries(&target, "delivery_log_by_outbox");
    assert_eq!(pointers.len(), 1, "only the row with an outbox id has one");
    assert!(
        pointers[0]
            .0
            .windows(linked.id.len())
            .any(|window| window == linked.id.as_bytes()),
        "the pointer names the linked row"
    );
}

#[tokio::test]
async fn a_migrated_job_writes_the_status_index_its_finder_reads() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");

    // Same `created_at`, one status apart, so the keys can differ only in the status.
    let mut submitted = dvm_job(3);
    submitted.status = DvmJobStatus::Submitted;
    submitted.created_at = at(5);
    let mut completed = dvm_job(4);
    completed.created_at = at(5);
    for job in [&submitted, &completed] {
        target
            .write_batch(&[MigrationRow::DvmJob(job.clone())])
            .await
            .expect("the job writes");
    }

    let entries = database_entries(&target, "dvm_jobs_by_status_created_at");
    assert_eq!(entries.len(), 2, "one pointer per job");
    let pointer_for = |job: &DvmJob| {
        entries
            .iter()
            .find(|(key, _)| key.ends_with(job.id.as_bytes()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .expect("a pointer for the job")
    };
    for job in [&submitted, &completed] {
        let (_, value) = pointer_for(job);
        assert!(value.is_empty(), "a status pointer carries no value");
    }

    // Both jobs have the same `created_at`, so the bytes before the id are the status: they
    // differ, and the finder's status prefix is what the writer put there.
    let submitted_prefix = {
        let (key, _) = pointer_for(&submitted);
        key[..key.len() - 32].to_vec()
    };
    let completed_prefix = {
        let (key, _) = pointer_for(&completed);
        key[..key.len() - 32].to_vec()
    };
    assert_ne!(
        submitted_prefix, completed_prefix,
        "the status leads the key, after the timestamp part"
    );
}

// ---------------------------------------------------------------------------------------
// AC18: a manifest that records progress over a missing store.
// ---------------------------------------------------------------------------------------

// The first half needs the binary's stderr and `run` builds a runtime of its own, so this is a
// plain test with a runtime it owns.
#[test]
fn a_manifest_that_records_progress_over_a_missing_store_is_refused() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("the test runtime builds");

    // Half one: a copy at --batch-size 2 that stops after its first batch, then its store gone.
    let partial = tempfile::tempdir().expect("a temporary directory");
    let partial_options = options(partial.path(), 2);
    let error = runtime.block_on(async {
        let target = LmdbBackend::open(partial.path())
            .await
            .expect("the store opens");
        migrate::migrate_with(
            &StubSource::failing_at(source_rows(), 1),
            &target,
            &partial_options,
            &mut Vec::new(),
        )
        .await
    });
    assert!(
        matches!(error, Err(nostream_cli::CliError::Migrate(_))),
        "the stub fails the second read_batch"
    );
    let manifest: Value = serde_json::from_slice(&manifest_bytes(partial.path()))
        .expect("the partial run's manifest parses");
    let dvm = &manifest["tables"]["dvm_jobs"];
    assert_eq!(dvm["rows"], 2, "the first batch is recorded");
    assert!(
        !dvm["after"].as_str().expect("a hex cursor").is_empty(),
        "and so is its cursor"
    );
    let store = partial.path().join("lmdb");
    std::fs::remove_dir_all(&store).expect("the store is removed");
    assert!(!store.exists());

    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--target"])
        .arg(partial.path())
        .args(["--batch-size", "2"])
        .env_clear()
        .output()
        .expect("the binary runs");
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Migration failed:"), "got: {stderr}");
    assert!(
        stderr.contains(&store.display().to_string()),
        "the line names <target>/lmdb: {stderr}"
    );
    assert!(!store.exists(), "the refused run created nothing");
    assert!(
        stderr.contains("a fresh --target"),
        "the refusal names the remedy: {stderr}"
    );

    // Half two: the manifest R6 writes, with no progress in it, over an empty directory.
    let fresh = tempfile::tempdir().expect("a temporary directory");
    write_manifest_fixture(fresh.path(), false);
    let fresh_store = fresh.path().join("lmdb");

    // `run` takes the copy path rather than the guard: a source it cannot parse fails it, not a
    // store, and it creates nothing. The URL is unparsable so no dial is attempted.
    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--target"])
        .arg(fresh.path())
        .env_clear()
        .env("DB_URI", "not-a-url")
        .output()
        .expect("the binary runs");
    assert_eq!(
        output.status.code(),
        Some(1),
        "there is no database to read"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !stderr.contains("No store"),
        "a zero-progress manifest is not refused: {stderr}"
    );
    assert!(
        !stderr.contains(&fresh_store.display().to_string()),
        "the failure is not about the store: {stderr}"
    );
    assert!(!fresh_store.exists());

    // And the copy that run would have driven completes over the same target.
    let copy = options(fresh.path(), 2);
    let (counts, complete) = runtime.block_on(async {
        let target = LmdbBackend::open(fresh.path())
            .await
            .expect("the store opens");
        let output = migrate::migrate_with(
            &StubSource::new(source_rows()),
            &target,
            &copy,
            &mut Vec::new(),
        )
        .await
        .expect("the copy succeeds");
        assert_eq!(output.exit_code, 0);
        let mut counts = Vec::new();
        for table in MigratedTable::ALL {
            counts.push(scan_all(&target, table).await.len());
        }
        let manifest: Value = serde_json::from_slice(&manifest_bytes(fresh.path()))
            .expect("the finished manifest parses");
        let complete = manifest["tables"]
            .as_object()
            .expect("the tables object")
            .values()
            .all(|entry| entry["complete"] == true);
        (counts, complete)
    });
    for count in counts {
        assert_eq!(count, 3, "nine tables at three rows");
    }
    assert!(complete, "every table is complete");
}

/// The process boundary the two failure tests above stop at: `main` prints
/// `Migration failed: {message}` and exits 1. No source is reachable here, so the run fails on
/// the way to the copy, which is the same arm.
#[test]
fn a_failed_run_reports_migration_failed_and_exits_1() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--target"])
        .arg(directory.path())
        .env("DB_URI", "postgres://127.0.0.1:1/nostream")
        // Nothing listens on port 1, so the failure is immediate; without this the pool still
        // retries to the 60 s acquire timeout, and this one test would be a minute of every run.
        .env("DB_ACQUIRE_CONNECTION_TIMEOUT", "1000")
        .output()
        .expect("the binary runs");

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.starts_with("Migration failed: "),
        "the failure is reported as one: {stderr}"
    );
}

// ---------------------------------------------------------------------------------------
// A process that never opened the store verifies it.
// ---------------------------------------------------------------------------------------

// Every other verify test runs in the process that opened the store writable, where heed's
// process-global registry already holds valid database handles, so a read-only opener that
// never commits its read transaction looks fine. The binary is the only way to get a process
// that has never opened the store, which is the shape a real `--verify` runs in.
#[test]
fn the_binary_verifies_a_store_this_process_wrote() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("the test runtime builds");

    let exit_code = runtime.block_on(async {
        let target = LmdbBackend::open(directory.path())
            .await
            .expect("the store opens");
        let output = migrate::migrate_with(
            &StubSource::new(source_rows()),
            &target,
            &options(directory.path(), 1_000),
            &mut Vec::new(),
        )
        .await
        .expect("the copy succeeds");
        output.exit_code
    });
    assert_eq!(exit_code, 0, "the copy completes");

    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--target"])
        .arg(directory.path())
        .arg("--verify")
        .env("DB_URI", "not-a-url")
        .env("DB_ACQUIRE_CONNECTION_TIMEOUT", "1000")
        .output()
        .expect("the binary runs");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(
        output.status.code(),
        Some(0),
        "a fresh process verifies what the store holds: stdout {stdout} stderr {stderr}"
    );
    assert!(
        stdout.starts_with("Verified 9 tables, "),
        "the verify reports its work: {stdout}"
    );
}

// ---------------------------------------------------------------------------------------
// The checksum is the number the document says it is.
// ---------------------------------------------------------------------------------------

// D4 states the row sum as the sum of `SHA-256(len32 ‖ key ‖ canonical)` per row, modulo 2^256,
// and the value exists so an independent checker can be written from that sentence. This
// literal was computed outside this crate from a single `events` row's bytes on exactly that
// framing, so a missing length prefix or a different order fails here instead of passing every
// criterion: the unit tests pin `sum_words`, not `add`.
#[tokio::test]
async fn the_row_checksum_matches_an_independent_computation() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");
    let source = StubSource::new(vec![MigrationRow::Event(event_record(1, "golden"))]);
    migrate::migrate_with(
        &source,
        &target,
        &options(directory.path(), 1_000),
        &mut Vec::new(),
    )
    .await
    .expect("the copy succeeds");

    let written = manifest(directory.path());
    let events = &written["tables"][MigratedTable::Events.name()];
    assert_eq!(events["rows"], 1, "one row was copied");
    assert_eq!(
        events["checksum"], "d81f052af7bfeb879aca5d630db8730d7168d6ca5cb2f5fc59f1a1c749150fbe",
        "the checksum an independent checker computes for this row"
    );
}

// ---------------------------------------------------------------------------------------
// A manifest that counts rows must find them in the store beside it.
// ---------------------------------------------------------------------------------------

// Asking about the store by its file tells a missing store from a present one, not a store the
// run wrote from one that lost its tables: a `data.mdb` can be there with none of the nine
// tables in it, and the copy would then add the remaining rows to a table that never held the
// ones the manifest counts, reporting success over a store missing them.
#[tokio::test]
async fn a_manifest_that_counts_rows_over_a_store_without_them_is_refused() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");

    let mut tables = serde_json::Map::new();
    for table in MigratedTable::ALL {
        let entry = if table.name() == MigratedTable::Events.name() {
            json!({"rows": 5, "checksum": "ab".repeat(32), "after": "", "complete": false})
        } else {
            json!({"rows": 0, "checksum": "0".repeat(64), "after": "", "complete": false})
        };
        tables.insert(table.name().to_owned(), entry);
    }
    let fixture =
        json!({"format": 1, "not_migrated": MigratedTable::NOT_MIGRATED, "tables": tables});
    std::fs::write(
        directory.path().join("migration-manifest.json"),
        serde_json::to_vec(&fixture).expect("the fixture serialises"),
    )
    .expect("the fixture manifest is written");

    let error = migrate::migrate_with(
        &StubSource::new(source_rows()),
        &target,
        &options(directory.path(), 1_000),
        &mut Vec::new(),
    )
    .await
    .expect_err("a store that never held the counted rows is refused");
    let message = error.to_string();
    assert!(message.contains("counts 5 rows"), "{message}");
    assert!(message.contains(MigratedTable::Events.name()), "{message}");
}

// ---------------------------------------------------------------------------------------
// The target and the manifest are not readable by anyone else.
// ---------------------------------------------------------------------------------------

// The manifest records the last key written per table, and for `invite_codes` that key is the
// invite code itself - a bearer credential NIP-43 accepts. The store's files are heed's 0600, so
// the manifest was the world-readable copy of it. The planted link is the second half: a
// temporary path that already exists must not be written through and renamed into place.
#[tokio::test]
async fn the_manifest_is_private_and_its_temporary_path_is_not_followed() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");
    let victim = directory.path().join("victim");
    std::fs::write(&victim, b"not the manifest").expect("the victim file is written");
    let temporary = directory.path().join("migration-manifest.json.tmp");
    std::os::unix::fs::symlink(&victim, &temporary).expect("the link is planted");

    migrate::migrate_with(
        &StubSource::new(vec![MigrationRow::Event(event_record(1, "golden"))]),
        &target,
        &options(directory.path(), 1_000),
        &mut Vec::new(),
    )
    .await
    .expect("the copy succeeds");

    assert_eq!(
        std::fs::read(&victim).expect("the victim still reads"),
        b"not the manifest",
        "the planted link's target is untouched"
    );
    let manifest = std::fs::symlink_metadata(directory.path().join("migration-manifest.json"))
        .expect("the manifest exists");
    assert!(
        !manifest.file_type().is_symlink(),
        "the manifest is a file, not the link"
    );
    assert_eq!(
        manifest.permissions().mode() & 0o777,
        0o600,
        "the manifest is readable by its owner alone"
    );
}

// A group- or world-writable target lets another local user pre-place the store and read what
// lands in it, so the copy refuses before opening anything.
#[test]
fn a_group_writable_target_is_refused() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().expect("a temporary directory");
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o777))
        .expect("the target is made world-writable");

    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--target"])
        .arg(directory.path())
        .env_clear()
        .env("DB_URI", "not-a-url")
        .output()
        .expect("the binary runs");

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("writable by group or other"),
        "the refusal says why: {stderr}"
    );
}

// A symlinked target sends the copy somewhere the operator did not name.
#[test]
fn a_symlinked_target_is_refused() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let real = root.path().join("real");
    std::fs::create_dir(&real).expect("the real directory is made");
    let link = root.path().join("link");
    std::os::unix::fs::symlink(&real, &link).expect("the link is planted");

    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--target"])
        .arg(&link)
        .env_clear()
        .env("DB_URI", "not-a-url")
        .output()
        .expect("the binary runs");

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("is a symlink"), "{stderr}");
}

// ---------------------------------------------------------------------------------------
// AC19: the source is named, and an unconfigured one fails at once.
// ---------------------------------------------------------------------------------------

// `from_env` falls back to `postgres@localhost:5432/postgres` when nothing is set, so a run with
// no `DB_URI` dials whatever local server is listening and copies it, and when nothing is
// listening it waits out the pool's acquire timeout.
#[test]
fn an_unconfigured_source_is_refused_at_once() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let started = std::time::Instant::now();
    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--target"])
        .arg(directory.path())
        .env_clear()
        .output()
        .expect("the binary runs");

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("DB_URI"), "the refusal names it: {stderr}");
    assert!(stderr.contains("DB_HOST"), "and the parts: {stderr}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "the refusal does not wait out the pool: {:?}",
        started.elapsed()
    );
}

// An unreachable host is reported as the database it could not read, with the password dropped.
#[test]
fn an_unreachable_source_is_named_without_its_password() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--target"])
        .arg(directory.path())
        .env_clear()
        .env("DB_URI", "postgres://alice:secret@127.0.0.1:1/nostream")
        .env("DB_ACQUIRE_CONNECTION_TIMEOUT", "1000")
        .output()
        .expect("the binary runs");

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("127.0.0.1:1/nostream"),
        "the failure names the host and database it resolved to: {stderr}"
    );
    assert!(stderr.contains("DB_URI"), "and the setting: {stderr}");
    assert!(
        !stderr.contains("secret"),
        "the password is not printed: {stderr}"
    );
    assert!(
        !stderr.contains("alice"),
        "the role is not printed either, only the host and database: {stderr}"
    );
}

// A URI can carry the password in a query parameter instead of the userinfo, and the description
// is printed into an error that reaches stderr and any captured log.
#[test]
fn a_query_string_password_is_not_printed() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--target"])
        .arg(directory.path())
        .env_clear()
        .env(
            "DB_URI",
            "postgres://127.0.0.1:1/nostream?password=secret&sslmode=require",
        )
        .env("DB_ACQUIRE_CONNECTION_TIMEOUT", "1000")
        .output()
        .expect("the binary runs");

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("127.0.0.1:1/nostream"),
        "the failure still names the source: {stderr}"
    );
    assert!(
        !stderr.contains("secret"),
        "the query-string password is not printed: {stderr}"
    );
}

// AC19 on the clock, not on a shortened timeout: the pool used to dial eagerly and spend its
// sixty-second acquire timeout before the probe could report anything.
#[test]
fn an_unreachable_source_fails_in_seconds_at_the_default_timeout() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let started = std::time::Instant::now();
    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--target"])
        .arg(directory.path())
        .env_clear()
        .env("DB_URI", "postgres://127.0.0.1:1/nostream")
        // The value the shipped `.env.example` carries: the probe must cap it, not inherit it.
        .env("DB_ACQUIRE_CONNECTION_TIMEOUT", "60000")
        .output()
        .expect("the binary runs");

    let elapsed = started.elapsed();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        elapsed < std::time::Duration::from_secs(25),
        "a refused source is reported in seconds, not at the pool's minute: {elapsed:?}"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("could not read the source at postgres://127.0.0.1:1/nostream"),
        "the failure names the source: {stderr}"
    );
    assert!(
        !stderr.contains("pool timed out"),
        "the driver's reason is what prints, not the pool's acquire message: {stderr}"
    );
}

// AC20: the remedy is in the command's own help, not only in the behaviour.
#[test]
fn the_help_names_the_resume_and_the_restart() {
    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--help"])
        .output()
        .expect("the binary runs");

    assert!(output.status.success(), "{}", output.status);
    let help = String::from_utf8_lossy(&output.stdout);
    assert!(
        help.contains("resumes"),
        "the help says a re-run resumes: {help}"
    );
    assert!(
        help.contains("fresh `--target`"),
        "and what starting over actually takes: {help}"
    );
    assert!(
        help.contains("relay must be stopped"),
        "and that the relay must be stopped: {help}"
    );
}

// AC7: the summary names the store the copy landed in, so a path that went through a link is
// visible as the real one rather than echoed back as the argument.
#[tokio::test]
async fn the_summary_names_the_canonical_store_not_the_argument() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let real = root.path().join("real");
    std::fs::create_dir(&real).expect("the real directory is made");
    let link = root.path().join("link");
    std::os::unix::fs::symlink(&real, &link).expect("the link is planted");
    let argument = link.join("store");
    std::fs::create_dir(&argument).expect("the target is made through the link");

    let target = LmdbBackend::open(&argument).await.expect("the store opens");
    let mut out = Vec::new();
    migrate::migrate_with(
        &StubSource::new(vec![MigrationRow::Event(event_record(1, "golden"))]),
        &target,
        &options(&argument, 1_000),
        &mut out,
    )
    .await
    .expect("the copy succeeds");

    let (_, _, _, store) = summary(&output_text(out));
    assert_ne!(
        store,
        argument.join("lmdb").display().to_string(),
        "the argument went through a link, so it is not what is reported"
    );
    assert_eq!(
        store,
        std::fs::canonicalize(real.join("store").join("lmdb"))
            .expect("the store exists")
            .display()
            .to_string(),
        "the summary names the real store"
    );
}

// U4: a `--target` that is a file is named as one, rather than reported as the operating
// system's `Not a directory (os error 20)` from a path the operator never wrote.
#[test]
fn a_target_that_is_a_file_is_refused() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let file = directory.path().join("not-a-dir");
    std::fs::write(&file, b"x").expect("the file is written");

    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--target"])
        .arg(&file)
        .env_clear()
        .env("DB_URI", "not-a-url")
        .output()
        .expect("the binary runs");

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("is not a directory"), "{stderr}");
}

// sqlx parses a schemeless string as a URL with no base: the opaque path becomes the database
// name and the host falls back to localhost, so the copy would dial the wrong server and a
// failure would echo the credentials back as a database name. The shape is refused before
// anything is dialled - which is stronger than redacting it.
#[test]
fn a_schemeless_source_uri_is_refused() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--target"])
        .arg(directory.path())
        .env_clear()
        .env("DB_URI", "postgres:alice:secret@127.0.0.1:1/nostream")
        .env("DB_ACQUIRE_CONNECTION_TIMEOUT", "1000")
        .output()
        .expect("the binary runs");

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("is not a URL with a host"),
        "the refusal names the shape: {stderr}"
    );
    assert!(
        !stderr.contains("secret"),
        "the password is not printed: {stderr}"
    );
}
