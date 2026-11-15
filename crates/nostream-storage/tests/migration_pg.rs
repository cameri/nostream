//! The migration against a real Postgres source.
//!
//! `PARITY_ADMIN_URL` names an administrative database; this target creates, migrates and seeds
//! a scratch one, copies the nine tables into a temporary LMDB store through the seam, and
//! compares them row for row. It is `#[ignore]`d for the repository's own reason — a checkout
//! without a database still has to pass `cargo test --workspace` — and CI's `Rust Checks` job
//! runs it with `--ignored`.
//!
//! Two things a copy has to get right are asserted here and nowhere else: the reader sees every
//! row the source holds, compared against `count(*)` rather than a constant, and the canonical
//! bytes of the rows the source read are the canonical bytes of the rows the store returns,
//! which is what an equal checksum in the manifest means. A second pass over the same source
//! writes the same keys and values, which is what a replayed batch and a resumed run rely on.
//!
//! The CLI's manifest, `--verify` and the throughput lines live in `nostream-cli`, which this
//! crate cannot depend on — the dependency runs the other way — so the manifest-driven half is
//! `crates/nostream-cli/tests/migrate_cli.rs`.

#![cfg(all(feature = "postgres", feature = "lmdb"))]
// This integration-test target may unwrap: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use chrono::{DateTime, NaiveDateTime, Utc};
use sqlx::postgres::PgPool;
use sqlx::{Executor, Row};

use nostream_storage::LmdbBackend;
use nostream_storage::migration::{MigratedTable, MigrationRow, MigrationSource, MigrationTarget};
use nostream_storage::postgres::PostgresBackend;

const DATABASE: &str = "nostream_migration_rust";

/// The paging the copy runs at here, small enough that a table of three is two pages.
const BATCH: usize = 2;

fn admin_url() -> String {
    std::env::var("PARITY_ADMIN_URL").expect(
        "PARITY_ADMIN_URL must name an administrative database, e.g. \
         postgres://postgres:postgres@host:5432/postgres",
    )
}

fn with_database(url: &str, database: &str) -> String {
    let (prefix, query) = match url.split_once('?') {
        Some((prefix, query)) => (prefix, Some(query)),
        None => (url, None),
    };
    let base = match prefix.rfind('/') {
        Some(index) if index > "postgres://".len() => &prefix[..index],
        _ => prefix,
    };
    match query {
        Some(query) => format!("{base}/{database}?{query}"),
        None => format!("{base}/{database}"),
    }
}

/// A naive instant (a `timestamp` column), 2020-01-01T00:00:00Z plus `offset` seconds.
fn naive(offset: i64) -> NaiveDateTime {
    timestamptz(offset).naive_utc()
}

/// A UTC instant (a `timestamptz` column), 2020-01-01T00:00:00Z plus `offset` seconds.
fn timestamptz(offset: i64) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp(1_577_836_800 + offset, 0).expect("a whole second")
}

fn canonical(row: &MigrationRow) -> Vec<u8> {
    row.canonical().expect("a row serialises")
}

/// Pages one table of the store to its end.
async fn scan_all(target: &LmdbBackend, table: MigratedTable) -> Vec<MigrationRow> {
    let mut rows = Vec::new();
    let mut after: Option<Vec<u8>> = None;
    loop {
        let page = MigrationTarget::scan_batch(target, table, after.as_deref(), BATCH)
            .await
            .expect("the store scans");
        let count = page.len();
        if let Some(last) = page.last() {
            after = Some(last.key());
        }
        rows.extend(page);
        if count < BATCH {
            return rows;
        }
    }
}

/// Copies one table of the source into the store, page by page, and answers the rows it read.
async fn copy_table(
    source: &PostgresBackend,
    target: &LmdbBackend,
    table: MigratedTable,
) -> Vec<MigrationRow> {
    let mut rows = Vec::new();
    let mut after: Option<Vec<u8>> = None;
    loop {
        let batch = MigrationSource::read_batch(source, table, after.as_deref(), BATCH)
            .await
            .expect("the source reads");
        let count = batch.len();
        if let Some(last) = batch.last() {
            after = Some(last.key());
        }
        let written = MigrationTarget::write_batch(target, &batch)
            .await
            .expect("the store writes");
        assert_eq!(
            written,
            count as u64,
            "{} writes every row it reads",
            table.name()
        );
        rows.extend(batch);
        if count < BATCH {
            return rows;
        }
    }
}

/// `count(*)` for one table, so the reader is compared with the source rather than a constant.
async fn source_count(pool: &PgPool, table: MigratedTable) -> i64 {
    let sql = match table {
        MigratedTable::DvmJobs => "SELECT count(*) FROM dvm_jobs",
        MigratedTable::Events => "SELECT count(*) FROM events",
        MigratedTable::InviteCodes => "SELECT count(*) FROM invite_codes",
        MigratedTable::Invoices => "SELECT count(*) FROM invoices",
        MigratedTable::Nip05Verifications => "SELECT count(*) FROM nip05_verifications",
        MigratedTable::NotificationDeliveryLog => "SELECT count(*) FROM notification_delivery_log",
        MigratedTable::NotificationOutbox => "SELECT count(*) FROM notification_outbox",
        MigratedTable::Reports => "SELECT count(*) FROM reports",
        MigratedTable::Users => "SELECT count(*) FROM users",
    };
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .fetch_one(pool)
        .await
        .expect("the source counts")
        .try_get::<i64, _>(0)
        .expect("a count")
}

/// A fresh scratch database with the schema applied.
///
/// The targets that use it run with `--test-threads=1` (CI and `scripts/storage-parity.sh`), so
/// two of them never drop the database under each other.
async fn scratch() -> PostgresBackend {
    let admin = PgPool::connect(&admin_url())
        .await
        .expect("the administrative database is reachable");
    admin
        .execute(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS {DATABASE} WITH (FORCE)"
        )))
        .await
        .expect("the scratch database drops");
    admin
        .execute(sqlx::AssertSqlSafe(format!("CREATE DATABASE {DATABASE}")))
        .await
        .expect("the scratch database is created");
    drop(admin);

    let source = PostgresBackend::connect(&with_database(&admin_url(), DATABASE))
        .await
        .expect("the scratch database is reachable");
    source.migrate().await.expect("the schema migrates");
    source
}

#[tokio::test]
#[ignore = "needs PARITY_ADMIN_URL; the Rust Checks job sets it"]
async fn a_seeded_source_copies_into_an_lmdb_store_that_matches_it() {
    let source = scratch().await;
    seed(&source).await;

    let directory = tempfile::tempdir().expect("a temporary directory");
    let target = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");

    for table in MigratedTable::ALL {
        let read = copy_table(&source, &target, table).await;
        assert_eq!(
            read.len() as i64,
            source_count(source.master(), table).await,
            "{} reads every row the source holds",
            table.name()
        );

        let scanned = scan_all(&target, table).await;
        assert_eq!(scanned.len(), read.len(), "{} count", table.name());

        let mut expected: Vec<Vec<u8>> = read.iter().map(canonical).collect();
        let mut actual: Vec<Vec<u8>> = scanned.iter().map(canonical).collect();
        expected.sort();
        actual.sort();
        assert_eq!(expected, actual, "{} canonical bytes", table.name());
    }

    // A second pass writes the same keys and values: the store's content does not move, which is
    // what makes a replayed batch and a resumed run harmless.
    for table in MigratedTable::ALL {
        let again = copy_table(&source, &target, table).await;
        assert_eq!(
            scan_all(&target, table).await.len(),
            again.len(),
            "{} holds one row per source row after a second pass",
            table.name()
        );
    }
}

/// Three rows at a batch size of two makes the second page real, which is the statement a wrong
/// cursor type rejects: `invoices.id` is `text` since
/// `migrations/20230205004400_change_invoice_id_to_string.sql` (so `id > $1::uuid` is a
/// server-side type error), `invite_codes.code` is a `varchar(64)` that takes the same text bind,
/// and the two notification tables' `id`s are `uuid`. Every page is read through the seam's own
/// reader, so the assertion is on the SQL that reader composes.
#[tokio::test]
#[ignore = "needs PARITY_ADMIN_URL; the Rust Checks job sets it"]
async fn every_text_and_uuid_cursor_pages_over_its_own_column_type() {
    let source = scratch().await;
    let pool = source.master();

    for seed in 1..=3u8 {
        let outbox_id = format!("40000000-0000-4000-8000-00000000000{seed}");
        sqlx::query(
            "INSERT INTO invoices (id, pubkey, bolt11, amount_requested, unit, status) \
             VALUES ($1, $2, $3, 1000, 'msats', 'completed')",
        )
        .bind(format!("30000000-0000-4000-8000-00000000000{seed}"))
        .bind(vec![4u8; 32])
        .bind(format!("lnbc1page{seed}"))
        .execute(pool)
        .await
        .expect("the invoice inserts");

        sqlx::query(
            "INSERT INTO notification_outbox (id, event_type, payload) \
             VALUES ($1::uuid, 'invoice.paid', $2)",
        )
        .bind(&outbox_id)
        .bind(serde_json::json!({ "seed": seed }))
        .execute(pool)
        .await
        .expect("the outbox row inserts");

        sqlx::query(
            "INSERT INTO notification_delivery_log (id, outbox_id, event_type, target_id, \
             target_type, status, attempt_number) \
             VALUES ($1::uuid, $2::uuid, 'invoice.paid', 'telegram:7175022', 'telegram', \
             'success', 1)",
        )
        .bind(format!("50000000-0000-4000-8000-00000000000{seed}"))
        .bind(&outbox_id)
        .execute(pool)
        .await
        .expect("the delivery-log row inserts");

        sqlx::query("INSERT INTO invite_codes (code) VALUES ($1)")
            .bind(format!("invite-{seed}"))
            .execute(pool)
            .await
            .expect("the invite code inserts");
    }

    for table in [
        MigratedTable::InviteCodes,
        MigratedTable::Invoices,
        MigratedTable::NotificationDeliveryLog,
        MigratedTable::NotificationOutbox,
    ] {
        let first = MigrationSource::read_batch(&source, table, None, BATCH)
            .await
            .expect("the first page reads");
        assert_eq!(first.len(), BATCH, "{} has a first page", table.name());
        let cursor = first.last().expect("a row").key();

        let second = MigrationSource::read_batch(&source, table, Some(&cursor), BATCH)
            .await
            .expect("the cursor binds as the column's own type");
        assert_eq!(
            second.len(),
            1,
            "{} pages past its first batch",
            table.name()
        );
        assert!(
            second[0].key() > cursor,
            "{} pages in key order",
            table.name()
        );

        let after = second.last().expect("a row").key();
        let third = MigrationSource::read_batch(&source, table, Some(&after), BATCH)
            .await
            .expect("the third page reads");
        assert!(third.is_empty(), "{} is exhausted", table.name());
    }
}

/// Two rows in each seeded table, except events (three, one per liveness state) and the two
/// tables the manifest does not move.
async fn seed(backend: &PostgresBackend) {
    let pool = backend.master();

    // events: live, soft-deleted, expired; a tag, a deduplication value and a first_seen.
    for (seed, deleted_at, expires_at) in [
        (1u8, None, None),
        (2u8, Some(naive(500)), None),
        (3u8, None, Some(1_577_836_800i32)),
    ] {
        sqlx::query(
            "INSERT INTO events (event_id, event_pubkey, event_kind, event_created_at, \
             event_content, event_signature, event_tags, first_seen, deleted_at, expires_at, \
             event_deduplication, remote_address) \
             VALUES ($1, $2, 1, $3, 'hello', $4, $5, $6, $7, $8, $9, $10::inet)",
        )
        .bind(vec![seed; 32])
        .bind(vec![1u8; 32])
        .bind(1_600_000_000i32 + i32::from(seed))
        .bind(vec![9u8; 64])
        .bind(serde_json::json!([["t", "x"]]))
        .bind(naive(0))
        .bind(deleted_at)
        .bind(expires_at)
        .bind(serde_json::json!(["abc"]))
        .bind(None::<String>)
        .execute(pool)
        .await
        .expect("the event inserts");
    }

    for seed in 1..=2u8 {
        sqlx::query(
            "INSERT INTO users (pubkey, is_admitted, is_vanished, balance, tos_accepted_at, \
             created_at, updated_at) VALUES ($1, true, false, $2, $3, $4, $4)",
        )
        .bind(vec![30 + seed; 32])
        .bind(if seed == 1 { 42i64 } else { 0 })
        .bind((seed == 1).then(|| naive(60)))
        .bind(timestamptz(0))
        .execute(pool)
        .await
        .expect("the user inserts");

        sqlx::query(
            "INSERT INTO invoices (id, pubkey, bolt11, amount_requested, amount_paid, unit, \
             status, description, confirmed_at, expires_at, created_at, updated_at) \
             VALUES ($1::uuid, $2, $3, 1000, $4, 'msats', $5, 'an invoice', $6, $7, $8, $8)",
        )
        .bind(format!("00000000-0000-4000-8000-00000000000{seed}"))
        .bind(vec![4u8; 32])
        .bind(format!("lnbc1invoice{seed}"))
        .bind((seed == 1).then_some(1_000i64))
        .bind(if seed == 1 { "completed" } else { "pending" })
        .bind((seed == 1).then(|| naive(50)))
        .bind(naive(60))
        .bind(timestamptz(0))
        .execute(pool)
        .await
        .expect("the invoice inserts");

        sqlx::query(
            "INSERT INTO reports (event_id, reporter_pubkey, reported_pubkey, reported_event_id, \
             report_type, weight, actionable, created_at) \
             VALUES ($1, $2, $3, NULL, 'spam', 1.5, true, $4)",
        )
        .bind(vec![40 + seed; 32])
        .bind(vec![5u8; 32])
        .bind(vec![6u8; 32])
        .bind(timestamptz(0))
        .execute(pool)
        .await
        .expect("the report inserts");

        sqlx::query(
            "INSERT INTO dvm_jobs (id, requester_pubkey, kind, worker_index, status, \
             result_event_id, error, picked_up_at, completed_at, created_at, updated_at) \
             VALUES ($1, $2, 5100, 1, 'completed', $3, NULL, $4, $5, $6, $6)",
        )
        .bind(vec![seed; 32])
        .bind(vec![2u8; 32])
        .bind(vec![200 + seed; 32])
        .bind(timestamptz(10))
        .bind(timestamptz(20))
        .bind(timestamptz(0))
        .execute(pool)
        .await
        .expect("the job inserts");
    }

    sqlx::query(
        "INSERT INTO nip05_verifications (pubkey, nip05, domain, is_verified, last_verified_at, \
         last_checked_at, failure_count, created_at, updated_at) \
         VALUES ($1, 'user@example.com', 'example.com', true, $2, $3, 1, $3, $2)",
    )
    .bind(vec![20u8; 32])
    .bind(timestamptz(80))
    .bind(timestamptz(90))
    .execute(pool)
    .await
    .expect("the verification inserts");

    sqlx::query(
        "INSERT INTO invite_codes (code, created_by, claimed_by, expires_at, remaining_uses, \
         created_at, updated_at) VALUES ('code-1', $1, NULL, $2, 2, $3, $3)",
    )
    .bind(vec![3u8; 32])
    .bind(timestamptz(100))
    .bind(timestamptz(0))
    .execute(pool)
    .await
    .expect("the invite code inserts");

    sqlx::query(
        "INSERT INTO notification_outbox (id, event_type, payload, status, attempt_count, \
         available_at, last_error, delivered_at, created_at, updated_at) \
         VALUES ($1::uuid, 'invoice.paid', $2, 'delivered', 1, $3, NULL, $4, $3, $4)",
    )
    .bind("10000000-0000-4000-8000-000000000001")
    .bind(serde_json::json!({ "amount": 1_000 }))
    .bind(timestamptz(120))
    .bind(timestamptz(130))
    .execute(pool)
    .await
    .expect("the outbox row inserts");

    sqlx::query(
        "INSERT INTO notification_delivery_log (id, outbox_id, event_type, target_id, \
         target_type, status, attempt_number, error_snippet, created_at) \
         VALUES ($1::uuid, $2::uuid, 'invoice.paid', 'telegram:7175022', 'telegram', 'success', \
         1, NULL, $3)",
    )
    .bind("20000000-0000-4000-8000-000000000001")
    .bind("10000000-0000-4000-8000-000000000001")
    .bind(timestamptz(110))
    .execute(pool)
    .await
    .expect("the delivery-log row inserts");
}
