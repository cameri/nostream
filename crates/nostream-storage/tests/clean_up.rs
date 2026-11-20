//! The clean-up seam: `scan_live`, `count_by_criteria`, `delete_by_criteria` and
//! `delete_all_events`, over the LMDB arm here and the Postgres arm behind `#[ignore]`.
//!
//! The predicates are the ones `nostream-cli clean-db` and `export` call, so each assertion is a
//! claim the CLI depends on: a page that is short only when the store is exhausted, a count and a
//! delete that select the same rows, and an emptying that leaves the metadata stores alone.
//!
//! The Postgres arm is `#[ignore]`d for the repository's own reason — a checkout without a
//! database still has to pass `cargo test --workspace` — and reads `PARITY_ADMIN_URL`, creating
//! its own scratch database the way `migration_pg.rs` does.

#![cfg(feature = "lmdb")]
// This integration-test target may unwrap: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use chrono::Utc;
use futures_util::StreamExt;

use nostream_core::{Event, EventId, Filter, Kind, Pubkey, Signature};
use nostream_storage::repositories::{
    CreateInviteCodeOptions, EventCleanCriteria, EventRecord, EventRepository, FieldUpdate,
    InviteCodeRepository, Invoice, InvoiceRepository, InvoiceStatus, InvoiceUnit, QueryStream,
    ScanCursor, UserPatch, UserRepository,
};
use nostream_storage::{DEFAULT_PAGE_ROWS, LmdbBackend, MAX_PAGE_ROWS, StorageError};

/// A signed note by the key `secret`, at `created_at`, with the given kind and tags.
fn note(secret: u8, kind: u64, created_at: i64, content: &str, tags: Vec<Vec<String>>) -> Event {
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
    event
}

/// One kind-1 record at `created_at`, its content the only thing telling it from a neighbour.
fn plain(created_at: i64) -> EventRecord {
    EventRecord::from_event(&note(
        11,
        1,
        created_at,
        &format!("row {created_at}"),
        Vec::new(),
    ))
}

/// Drains one `scan_live` page.
async fn page(stream: QueryStream<'_, EventRecord>) -> Vec<EventRecord> {
    let mut rows = Vec::new();
    let mut stream = stream;
    while let Some(item) = stream.next().await {
        rows.push(item.expect("a scan yields its rows"));
    }
    rows
}

/// The cursor a page ends at, for the page that follows it.
fn cursor(record: &EventRecord) -> ScanCursor {
    ScanCursor {
        created_at: record.event.created_at,
        event_id: record.event.id,
    }
}

async fn store() -> (tempfile::TempDir, LmdbBackend) {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let backend = LmdbBackend::open(directory.path())
        .await
        .expect("the store opens");
    (directory, backend)
}

/// AC50: the full scan pages by its own cursor, ascends by `(created_at, event_id)`, and is short
/// only when the store has nothing more to give.
#[tokio::test]
async fn scan_live_pages_the_store_and_shortens_only_at_its_end() {
    let (_directory, backend) = store().await;
    let rows: Vec<EventRecord> = (0..MAX_PAGE_ROWS as i64 + 1)
        .map(|step| plain(1_700_000_000 + step))
        .collect();
    backend
        .create_many(&rows)
        .await
        .expect("the rows are written");

    let first = page(
        backend
            .scan_live(None, MAX_PAGE_ROWS)
            .await
            .expect("a scan starts"),
    )
    .await;
    assert_eq!(
        first.len() as u64,
        MAX_PAGE_ROWS,
        "a full page holds exactly the bound"
    );
    assert!(
        first
            .windows(2)
            .all(|pair| (pair[0].event.created_at, pair[0].event.id)
                < (pair[1].event.created_at, pair[1].event.id)),
        "the page ascends by (created_at, event_id)"
    );

    let rest = page(
        backend
            .scan_live(
                Some(cursor(first.last().expect("a page has rows"))),
                MAX_PAGE_ROWS,
            )
            .await
            .expect("the scan resumes"),
    )
    .await;
    assert_eq!(rest.len(), 1, "the second page is the one row past 5 000");

    let thousand = page(
        backend
            .scan_live(None, DEFAULT_PAGE_ROWS * 2)
            .await
            .expect("a page of 1 000"),
    )
    .await;
    assert_eq!(thousand.len(), 1_000, "a limit below the bound is honoured");
}

/// AC50: a cursor's row that a delete removed, and a soft-deleted or expired row in the middle,
/// cost a page no slot — the page is still filled from what is live.
#[tokio::test]
async fn a_hidden_row_does_not_shorten_a_page() {
    let (_directory, backend) = store().await;
    let base = 1_700_000_000;
    let rows: Vec<EventRecord> = (0..5).map(|step| plain(base + step * 10)).collect();
    backend
        .create_many(&rows[..3])
        .await
        .expect("the rows are written");

    // `base + 10` is soft-deleted (a live row's neighbour), and `base + 30` is expired (a hidden
    // row between two live ones): neither may cost a page a slot.
    backend
        .delete_by_pubkey_and_ids(&rows[1].event.pubkey, &[rows[1].event.id])
        .await
        .expect("the row is soft-deleted");
    let mut expired =
        EventRecord::from_event(&note(12, 1, base + 30, "an expired row", Vec::new()));
    expired.expires_at = Some(Utc::now().timestamp() - 60);
    EventRepository::create(&backend, &expired)
        .await
        .expect("the expired row");
    EventRepository::create(&backend, &rows[4])
        .await
        .expect("the row past the expired one");

    let first = page(backend.scan_live(None, 2).await.expect("a scan starts")).await;
    assert_eq!(
        first.len(),
        2,
        "the page is filled from the live rows only: the soft-deleted row spent no slot"
    );
    assert_eq!(first[0].event.created_at, base);
    assert_eq!(
        first[1].event.created_at,
        base + 20,
        "the soft-deleted row between them is skipped, not counted"
    );

    let second = page(
        backend
            .scan_live(Some(cursor(&first[1])), 1)
            .await
            .expect("the scan resumes"),
    )
    .await;
    assert_eq!(
        second.len(),
        1,
        "the expired row spends no slot, so the page is still filled"
    );
    assert_eq!(second[0].event.created_at, base + 40);

    let third = page(
        backend
            .scan_live(Some(cursor(&second[0])), 5)
            .await
            .expect("the scan resumes"),
    )
    .await;
    assert!(
        third.is_empty(),
        "past the last live row the store is exhausted"
    );
}

/// AC51: the count and the delete are one predicate, the comparison is strict, and soft-deleted
/// rows are in it. The test names one literal `cutoff` and uses it twice — as one row's
/// `created_at` and as the criteria's `before` — which is the only way `<` and `<=` are told
/// apart.
#[tokio::test]
async fn the_criteria_count_and_delete_the_same_rows() {
    let (_directory, backend) = store().await;
    let cutoff = 1_700_000_000i64;
    const DAY: i64 = 86_400;

    let tagged = |kind: u64, created_at: i64, tag: &str, content: &str| {
        EventRecord::from_event(&note(
            21,
            kind,
            created_at,
            content,
            vec![vec!["t".to_owned(), tag.to_owned()]],
        ))
    };

    let old_kind_one = tagged(1, cutoff - 10 * DAY, "gone", "old kind 1");
    let old_kind_seven = tagged(7, cutoff - 10 * DAY, "kept", "old kind 7");
    let new_kind_one = tagged(1, cutoff + 20 * DAY, "kept", "new kind 1");
    let old_deleted = tagged(1, cutoff - 10 * DAY, "gone", "old soft-deleted kind 1");
    let at_cutoff = tagged(7, cutoff, "kept", "exactly at the cutoff");

    let rows = vec![
        old_kind_one.clone(),
        old_kind_seven.clone(),
        new_kind_one.clone(),
        old_deleted.clone(),
        at_cutoff.clone(),
    ];
    backend
        .create_many(&rows)
        .await
        .expect("the rows are written");
    backend
        .delete_by_pubkey_and_ids(&old_deleted.event.pubkey, &[old_deleted.event.id])
        .await
        .expect("one row is soft-deleted");

    assert_eq!(
        backend
            .count_by_criteria(&EventCleanCriteria::default())
            .await
            .expect("a count"),
        5,
        "the default predicate counts every stored row, soft-deleted ones included"
    );
    assert_eq!(
        backend
            .count_by_criteria(&EventCleanCriteria {
                before: Some(cutoff),
                kinds: None,
            })
            .await
            .expect("a count"),
        3,
        "a row at exactly `before` is not selected: the predicate is `<`"
    );
    assert_eq!(
        backend
            .count_by_criteria(&EventCleanCriteria {
                before: Some(cutoff),
                kinds: Some(vec![Kind(1)]),
            })
            .await
            .expect("a count"),
        2,
        "the soft-deleted old kind-1 row is in the selection"
    );

    let deleted = backend
        .delete_by_criteria(&EventCleanCriteria {
            before: Some(cutoff),
            kinds: Some(vec![Kind(1)]),
        })
        .await
        .expect("a delete");
    assert_eq!(deleted, 2, "the delete removes what the count counted");

    let remaining = page(
        backend
            .scan_live(None, MAX_PAGE_ROWS)
            .await
            .expect("a scan"),
    )
    .await;
    assert_eq!(remaining.len(), 3, "three rows are left");
    assert!(
        remaining
            .iter()
            .any(|record| record.event.id == at_cutoff.event.id),
        "the row at exactly the cutoff survives"
    );

    // The tag index went with the deleted rows: the surviving rows' tags are still found, and the
    // deleted rows' are not.
    let gone = Filter {
        tags: BTreeMap::from([("#t".to_owned(), vec!["gone".to_owned()])]),
        ..Filter::default()
    };
    let kept = Filter {
        tags: BTreeMap::from([("#t".to_owned(), vec!["kept".to_owned()])]),
        ..Filter::default()
    };
    assert_eq!(
        backend
            .count_by_filters(std::slice::from_ref(&gone))
            .await
            .expect("a count"),
        0,
        "a deleted row's tag entry is gone"
    );
    assert_eq!(
        backend
            .count_by_filters(std::slice::from_ref(&kept))
            .await
            .expect("a count"),
        3,
        "the surviving rows keep their tag entries"
    );
}

/// AC51's kind selection: a kind the store's header cannot hold names no row. The LMDB header
/// keeps a kind as `i32`, and the criteria used to coerce anything above it onto `i32::MAX`,
/// which selected — and hard-deleted — a row the criteria never named. The Postgres arm already
/// refused the same input, so this pins the two backends to one answer.
#[tokio::test]
async fn an_out_of_range_kind_is_refused_and_deletes_nothing() {
    let (_directory, backend) = store().await;

    let top = EventRecord::from_event(&note(
        11,
        i32::MAX as u64,
        1_700_000_000,
        "the top kind",
        Vec::new(),
    ));
    backend
        .create_many(std::slice::from_ref(&top))
        .await
        .expect("the row is written");

    let criteria = EventCleanCriteria {
        before: None,
        kinds: Some(vec![Kind(4_294_967_296)]),
    };

    let counted = backend.count_by_criteria(&criteria).await;
    assert!(
        matches!(counted, Err(StorageError::ValueOutOfRange { .. })),
        "an out-of-range kind is refused, not coerced: {counted:?}"
    );

    let deleted = backend.delete_by_criteria(&criteria).await;
    assert!(
        matches!(deleted, Err(StorageError::ValueOutOfRange { .. })),
        "the delete refuses the same input the count refuses: {deleted:?}"
    );
    assert_eq!(
        backend
            .count_by_criteria(&EventCleanCriteria::default())
            .await
            .expect("a count"),
        1,
        "the i32::MAX kind survives a criteria that never named it"
    );
}

/// AC51's transaction boundary: LMDB allows one writer per environment, so a delete that
/// collected and removed every batch inside one transaction held the writer for the whole run.
/// One batch is collected in a read transaction and deleted in its own write transaction, so the
/// environment commits once per batch and a second writer gets in between them.
///
/// `last_txn_id` counts committed write transactions, so the assertion is the boundary itself
/// rather than a timing: 25 001 rows at the shipped `CLEAN_BATCH_ROWS` = 10 000 are two full
/// batches and a one-row tail, one commit each. The row count is a literal on purpose — a batch
/// size large enough to make this one transaction fails here, so the constant cannot move without
/// a red, and ADR 0015's D13 is where a move is argued.
#[tokio::test]
async fn the_writer_is_released_between_batches() {
    let (_directory, backend) = store().await;

    let total = 25_001i64;
    let rows: Vec<EventRecord> = (0..total).map(|step| plain(1_700_000_000 + step)).collect();
    backend
        .create_many(&rows)
        .await
        .expect("the rows are written");

    let before = backend.env().info().last_txn_id;
    let deleted = backend
        .delete_by_criteria(&EventCleanCriteria::default())
        .await
        .expect("a delete");
    let committed = backend.env().info().last_txn_id - before;

    assert_eq!(deleted, total as u64, "the delete removes every row");
    assert!(
        committed >= 3,
        "the delete committed {committed} write transaction(s) for {total} rows: one batch per \
         transaction is what releases the writer, one transaction for the run is the defect"
    );
}

/// AC52: `delete_all_events` empties the event store and nothing else.
#[tokio::test]
async fn delete_all_events_leaves_the_metadata_stores_alone() {
    let (_directory, backend) = store().await;
    let now = Utc::now();

    let events: Vec<EventRecord> = (0..3).map(|step| plain(1_700_000_000 + step)).collect();
    backend
        .create_many(&events)
        .await
        .expect("the events are written");

    let invite = InviteCodeRepository::create(
        &backend,
        "0123456789abcdef0123456789abcdef",
        &CreateInviteCodeOptions {
            expires_at: None,
            remaining_uses: FieldUpdate::Set(1),
            created_by: None,
        },
    )
    .await
    .expect("the invite code is minted");
    let invoice = Invoice {
        id: "40000000-0000-4000-8000-000000000001".to_owned(),
        pubkey: Pubkey::from_byte_array([5; 32]),
        bolt11: "lnbc1cleanup".to_owned(),
        amount_requested: 1_000,
        amount_paid: None,
        unit: InvoiceUnit::Msats,
        status: InvoiceStatus::Pending,
        description: "a row the clean-up must not touch".to_owned(),
        confirmed_at: None,
        expires_at: None,
        updated_at: now,
        created_at: now,
        verify_url: None,
    };
    InvoiceRepository::upsert(&backend, &invoice)
        .await
        .expect("the invoice is written");
    UserRepository::upsert(
        &backend,
        &UserPatch {
            pubkey: Pubkey::from_byte_array([6; 32]),
            is_admitted: FieldUpdate::Set(true),
            is_vanished: FieldUpdate::Absent,
            tos_accepted_at: FieldUpdate::Absent,
        },
    )
    .await
    .expect("the user is written");

    backend
        .delete_all_events()
        .await
        .expect("the event store empties");

    assert_eq!(
        backend
            .count_by_filters(&[Filter::default()])
            .await
            .expect("a count"),
        0,
        "no live event is left"
    );
    assert_eq!(
        backend
            .count_by_criteria(&EventCleanCriteria::default())
            .await
            .expect("a count"),
        0,
        "no event row is left, soft-deleted or not"
    );
    assert!(
        page(
            backend
                .scan_live(None, MAX_PAGE_ROWS)
                .await
                .expect("a scan")
        )
        .await
        .is_empty(),
        "the created-at index yields nothing"
    );
    assert!(
        backend
            .find_by_code(&invite.code)
            .await
            .expect("the invite reads")
            .is_some(),
        "the invite code survives"
    );
    assert!(
        backend
            .find_by_id(&invoice.id)
            .await
            .expect("the invoice reads")
            .is_some(),
        "the invoice survives"
    );
    assert!(
        backend
            .find_by_pubkey(&Pubkey::from_byte_array([6; 32]))
            .await
            .expect("the user reads")
            .is_some(),
        "the user survives"
    );
}

#[cfg(feature = "postgres")]
mod postgres_arm {
    use super::*;

    use sqlx::postgres::PgPool;
    use sqlx::{Executor, Row};

    use nostream_storage::postgres::PostgresBackend;

    const DATABASE: &str = "nostream_clean_up_rust";

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

    /// A fresh scratch database with the schema applied, as `migration_pg.rs` makes one.
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

    /// AC53: the same three assertions against `PostgresBackend`.
    #[tokio::test]
    #[ignore = "needs PARITY_ADMIN_URL; the Rust Checks job sets it"]
    async fn the_postgres_arm_answers_the_three_assertions() {
        let backend = scratch().await;
        let cutoff = 1_700_000_000i64;
        const DAY: i64 = 86_400;

        let rows: Vec<EventRecord> = (0..MAX_PAGE_ROWS as i64 + 1)
            .map(|step| plain(1_700_000_000 + step))
            .collect();
        backend
            .create_many(&rows)
            .await
            .expect("the rows are written");

        let first = page(
            backend
                .scan_live(None, MAX_PAGE_ROWS)
                .await
                .expect("a scan starts"),
        )
        .await;
        assert_eq!(first.len() as u64, MAX_PAGE_ROWS, "a full page");
        assert!(
            first
                .windows(2)
                .all(|pair| (pair[0].event.created_at, pair[0].event.id)
                    < (pair[1].event.created_at, pair[1].event.id)),
            "the page ascends by (created_at, event_id)"
        );
        let rest = page(
            backend
                .scan_live(
                    Some(cursor(first.last().expect("a page has rows"))),
                    MAX_PAGE_ROWS,
                )
                .await
                .expect("the scan resumes"),
        )
        .await;
        assert_eq!(
            rest.len(),
            1,
            "the second page is the one row past the bound"
        );

        // The predicate, over its own rows and its own scratch store state.
        backend
            .delete_all_events()
            .await
            .expect("the event store empties");
        let at_cutoff =
            EventRecord::from_event(&note(22, 7, cutoff, "exactly at the cutoff", Vec::new()));
        let old_one = EventRecord::from_event(&note(
            23,
            1,
            cutoff - 10 * DAY,
            "old kind 1",
            vec![vec!["t".to_owned(), "gone".to_owned()]],
        ));
        let old_deleted = EventRecord::from_event(&note(
            24,
            1,
            cutoff - 10 * DAY,
            "old soft-deleted kind 1",
            Vec::new(),
        ));
        backend
            .create_many(&[
                at_cutoff.clone(),
                old_one.clone(),
                old_deleted.clone(),
                EventRecord::from_event(&note(25, 1, cutoff + 20 * DAY, "new kind 1", Vec::new())),
                EventRecord::from_event(&note(26, 7, cutoff - 10 * DAY, "old kind 7", Vec::new())),
            ])
            .await
            .expect("the rows are written");
        backend
            .delete_by_pubkey_and_ids(&old_deleted.event.pubkey, &[old_deleted.event.id])
            .await
            .expect("one row is soft-deleted");

        assert_eq!(
            backend
                .count_by_criteria(&EventCleanCriteria::default())
                .await
                .expect("a count"),
            5,
            "every row counts, soft-deleted ones included"
        );
        assert_eq!(
            backend
                .count_by_criteria(&EventCleanCriteria {
                    before: Some(cutoff),
                    kinds: None,
                })
                .await
                .expect("a count"),
            3,
            "a row at exactly `before` is not selected"
        );
        assert_eq!(
            backend
                .delete_by_criteria(&EventCleanCriteria {
                    before: Some(cutoff),
                    kinds: Some(vec![Kind(1)]),
                })
                .await
                .expect("a delete"),
            2,
            "the delete removes what the count counted"
        );
        assert!(
            page(
                backend
                    .scan_live(None, MAX_PAGE_ROWS)
                    .await
                    .expect("a scan")
            )
            .await
            .iter()
            .any(|record| record.event.id == at_cutoff.event.id),
            "the row at exactly the cutoff survives"
        );

        // `delete_all_events` leaves no `event_tags` row behind: the trigger does not fire on
        // `TRUNCATE`, so the truncate names the table.
        backend
            .delete_all_events()
            .await
            .expect("the event store empties");
        let tags: i64 = sqlx::query("SELECT count(*) AS count FROM event_tags")
            .fetch_one(backend.master())
            .await
            .expect("event_tags counts")
            .try_get("count")
            .expect("a count");
        assert_eq!(tags, 0, "event_tags is emptied with the events");
    }
}
