//! The `migrate pg-to-lmdb` command's contract: the copy, the manifest, resume, verify and the
//! run's own throughput measurement.
//!
//! Every test drives `migrate_with`/`verify_with` over a constructed source and a real
//! `LmdbBackend` on a `TempDir`, so no database and no process is involved; the one test that
//! needs a process runs the binary and reads its stderr.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

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

/// A target a verify must never touch: every method panics.
struct UntouchedTarget;

impl MigrationTarget for UntouchedTarget {
    fn write_batch<'a>(&'a self, _rows: &'a [MigrationRow]) -> StorageFuture<'a, u64> {
        panic!("verify must not write to the store")
    }

    fn scan_batch<'a>(
        &'a self,
        _table: MigratedTable,
        _after: Option<&'a [u8]>,
        _limit: usize,
    ) -> StorageFuture<'a, Vec<MigrationRow>> {
        panic!("verify must answer a missing manifest before it scans")
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
fn database_keys(backend: &LmdbBackend, name: &str) -> Vec<Vec<u8>> {
    let txn = backend.env().read_txn().expect("a read transaction");
    let database = backend
        .env()
        .open_database::<Bytes, Bytes>(&txn, Some(name))
        .expect("the database opens")
        .expect("the database exists");
    database
        .iter(&txn)
        .expect("the database iterates")
        .map(|entry| entry.expect("a stored entry").0.to_vec())
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

#[tokio::test]
async fn verify_rejects_a_missing_manifest_with_a_message_and_exit_1() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let options = MigrateOptions {
        verify: true,
        ..options(directory.path(), 1_000)
    };

    let mut out = Vec::new();
    let output = migrate::verify_with(&UntouchedTarget, &options, &mut out)
        .await
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
        "the line names the path it looked for: {text}"
    );
    assert_eq!(
        std::fs::read_dir(directory.path())
            .expect("the directory reads")
            .count(),
        0,
        "verify created nothing"
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
fn summary(text: &str) -> (u64, u64, u64) {
    let mut lines = text.lines();
    let first = lines.next().expect("the rows line");
    let second = lines.next().expect("the throughput line");
    assert_eq!(lines.next(), None, "exactly two summary lines");

    let (rows_text, rest) = first
        .strip_prefix("Migrated ")
        .and_then(|rest| rest.split_once(" rows in "))
        .expect("the rows line's shape");
    let ms_text = rest.strip_suffix(" ms").expect("the milliseconds");
    let rate_text = second
        .strip_prefix("Events throughput: ")
        .and_then(|rest| rest.strip_suffix(" events/s"))
        .expect("the throughput line's shape");

    (
        rows_text.parse().expect("a row count"),
        ms_text.parse().expect("a millisecond count"),
        rate_text.parse().expect("a rate"),
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
    let (rows, ms, rate) = summary(&output_text(out));

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
        .output()
        .expect("the binary runs");

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.starts_with("Migration failed: "),
        "the failure is reported as one: {stderr}"
    );
}
