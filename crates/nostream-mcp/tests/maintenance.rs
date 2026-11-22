//! AC3–AC7 — the two maintenance tools: the purge the worker runs, the counts the store answers,
//! and the record a later call reads, through the protocol a client uses.
//!
//! | case | what it proves |
//! |---|---|
//! | `maintenance_run_purges_a_row_of_each_class_and_the_store_says_so` | one call purges a soft-deleted, an expired and an over-retention row, answers `1/1/1`, and the store no longer holds them |
//! | `maintenance_run_without_retention_answers_zeros_and_purges_nothing` | the guard answers three zeros with the row still stored, and a rewritten settings file makes the next call purge it |
//! | `a_second_run_answers_zeros_and_the_record_is_the_second_run` | the record is replaced, not summed: the second call's counts and stamp, read by a second client |
//! | `maintenance_last_run_is_null_before_a_run_and_the_record_after_one` | `{"run": null}` on a fresh process, and the run's own object after one |
//! | `a_read_only_document_reads_the_record_and_is_refused_the_run` | a `Requires::Read` document reads the record, is denied the run, and the denial purges nothing |
//!
//! The store's purge reads `Utc::now().timestamp()` (`crates/nostream-storage/src/lmdb/mod.rs`),
//! not the harness clock, so the rows are seeded relative to wall time while the record's stamp
//! is the fixture clock's `NOW_MS`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use chrono::Utc;
use common::{Fixture, Grant, TestMcp, event, id_of, payload, text};
use nostream_mcp::{AUDIT_DENIED, TOOL_MAINTENANCE_LAST_RUN, TOOL_MAINTENANCE_RUN, audit_action};
use nostream_storage::repositories::{EventRecord, EventRepository};
use serde_json::{Value, json};

/// The fixture clock's instant, which is the record's `ranAt`.
const NOW_RAN_AT: &str = "2023-11-14T22:13:20.000Z";

/// The same, one minute later: the stamp a second run carries.
const NEXT_RAN_AT: &str = "2023-11-14T22:14:20.000Z";

/// The fixture's settings with the retention the tool acts on: a row older than a week is a
/// candidate, and one older than nothing at all is not.
fn retained_fixture() -> Fixture {
    Fixture::default().with("limits.event.retention.maxDays", json!(7))
}

fn retained_settings() -> serde_yaml::Value {
    retained_fixture().settings
}

/// The four rows the purge classes need, and the ids a read-back names.
struct Classes {
    deleted: EventRecord,
    expired: EventRecord,
    retained: EventRecord,
    live: EventRecord,
}

/// Seeds one row of each purge class and one live, recent row — relative to the store's own
/// clock — and soft-deletes the first through the store's own delete.
async fn seed_classes(fixture: &TestMcp) -> Classes {
    let now = Utc::now().timestamp();
    let deleted = event(41, 1, now - 60);
    let expired = event(42, 1, now).with_expires_at(now - 1);
    let retained = event(43, 1, now - 30 * 86_400);
    let live = event(44, 1, now - 60);
    fixture
        .seed(&[
            deleted.clone(),
            expired.clone(),
            retained.clone(),
            live.clone(),
        ])
        .await;

    let soft_deleted = EventRepository::delete_by_pubkey_and_ids(
        &*fixture.backend,
        &deleted.event.pubkey,
        &[deleted.event.id],
    )
    .await
    .expect("the store's own soft delete");
    assert_eq!(soft_deleted, 1, "the soft delete marks the one row");

    Classes {
        deleted,
        expired,
        retained,
        live,
    }
}

/// The row the store holds for `record`, read through the store rather than the payload.
async fn stored(fixture: &TestMcp, record: &EventRecord) -> Option<EventRecord> {
    EventRepository::find_stored(&*fixture.backend, &record.event.id)
        .await
        .expect("the store's own read")
}

fn actions(fixture: &TestMcp) -> Vec<String> {
    fixture
        .audit_entries()
        .iter()
        .map(|entry| entry["action"].as_str().unwrap_or_default().to_owned())
        .collect()
}

fn run(ran_at: &str, counts: [u64; 3]) -> Value {
    json!({
        "run": {
            "ranAt": ran_at,
            "deleted": counts[0],
            "expired": counts[1],
            "retained": counts[2],
        }
    })
}

#[tokio::test]
async fn maintenance_run_purges_a_row_of_each_class_and_the_store_says_so() {
    let fixture = TestMcp::start_with(retained_fixture()).await;
    let classes = seed_classes(&fixture).await;
    let client = fixture.client().await;

    let result = client.call(TOOL_MAINTENANCE_RUN, json!({})).await;

    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    assert_eq!(
        payload(&result),
        run(NOW_RAN_AT, [1, 1, 1]),
        "the three classes, as the store counted them"
    );
    for record in [&classes.deleted, &classes.expired, &classes.retained] {
        assert!(
            stored(&fixture, record).await.is_none(),
            "{} was purged",
            id_of(record)
        );
    }
    assert!(
        stored(&fixture, &classes.live).await.is_some(),
        "the live, recent row survives the pass"
    );
}

#[tokio::test]
async fn maintenance_run_without_retention_answers_zeros_and_purges_nothing() {
    let fixture = TestMcp::start().await;
    let now = Utc::now().timestamp();
    let retained = event(45, 1, now - 30 * 86_400);
    fixture.seed(std::slice::from_ref(&retained)).await;
    let client = fixture.client().await;

    let guarded = client.call(TOOL_MAINTENANCE_RUN, json!({})).await;
    assert_eq!(guarded.is_error, Some(false), "{}", text(&guarded));
    assert_eq!(
        payload(&guarded),
        run(NOW_RAN_AT, [0, 0, 0]),
        "the guard's three zeros"
    );
    assert!(
        stored(&fixture, &retained).await.is_some(),
        "the guard answered without calling the store, so nothing was purged"
    );

    // The settings are read per call: the same process, a rewritten file, a real purge.
    fixture.write_settings(&retained_settings());
    let purged = client.call(TOOL_MAINTENANCE_RUN, json!({})).await;
    assert_eq!(purged.is_error, Some(false), "{}", text(&purged));
    assert_eq!(
        payload(&purged),
        run(NOW_RAN_AT, [0, 0, 1]),
        "the retained row, once retention is configured"
    );
    assert!(
        stored(&fixture, &retained).await.is_none(),
        "the row the first call could not touch is gone"
    );
}

#[tokio::test]
async fn a_second_run_answers_zeros_and_the_record_is_the_second_run() {
    let fixture = TestMcp::start_with(retained_fixture()).await;
    let _classes = seed_classes(&fixture).await;
    let client = fixture.client().await;

    let first = client.call(TOOL_MAINTENANCE_RUN, json!({})).await;
    assert_eq!(
        payload(&first),
        run(NOW_RAN_AT, [1, 1, 1]),
        "the first call purges the three classes"
    );

    fixture.clock.advance(60_000);
    let second = client.call(TOOL_MAINTENANCE_RUN, json!({})).await;
    let expected = run(NEXT_RAN_AT, [0, 0, 0]);
    assert_eq!(
        payload(&second),
        expected,
        "the purged candidates are gone, and the stamp is the moved clock's"
    );

    let record = client.call(TOOL_MAINTENANCE_LAST_RUN, json!({})).await;
    assert_eq!(
        payload(&record),
        expected,
        "the record is the second run: not a sum, and not the first stamp"
    );

    // A second client, and a second server over the same state: the record is the process's.
    let same_state = fixture.client().await;
    assert_eq!(
        payload(&same_state.call(TOOL_MAINTENANCE_LAST_RUN, json!({})).await),
        expected
    );
}

#[tokio::test]
async fn maintenance_last_run_is_null_before_a_run_and_the_record_after_one() {
    let fresh = TestMcp::start().await;
    let client = fresh.client().await;

    let never = client.call(TOOL_MAINTENANCE_LAST_RUN, json!({})).await;
    assert_eq!(never.is_error, Some(false), "{}", text(&never));
    assert_eq!(
        payload(&never),
        json!({ "run": null }),
        "never ran is null, not three zeros"
    );
    assert_eq!(
        actions(&fresh),
        vec![audit_action(TOOL_MAINTENANCE_LAST_RUN)]
    );

    // A fresh process state starts with nothing recorded, whatever another one ran.
    let other = TestMcp::start().await;
    let other_client = other.client().await;
    assert_eq!(
        payload(
            &other_client
                .call(TOOL_MAINTENANCE_LAST_RUN, json!({}))
                .await
        ),
        json!({ "run": null })
    );

    // Half 2: the record is the run's own object, field for field.
    let fixture = TestMcp::start_with(retained_fixture()).await;
    let classes = seed_classes(&fixture).await;
    let client = fixture.client().await;

    let ran = client.call(TOOL_MAINTENANCE_RUN, json!({})).await;
    assert_eq!(ran.is_error, Some(false), "{}", text(&ran));
    let read = client.call(TOOL_MAINTENANCE_LAST_RUN, json!({})).await;
    assert_eq!(read.is_error, Some(false), "{}", text(&read));
    assert_eq!(
        payload(&read)["run"],
        payload(&ran)["run"],
        "the record is the object the run answered"
    );
    assert_eq!(
        payload(&read),
        run(NOW_RAN_AT, [1, 1, 1]),
        "stamped by the fixture clock, with the classes the store purged"
    );
    for record in [&classes.deleted, &classes.expired, &classes.retained] {
        assert!(
            stored(&fixture, record).await.is_none(),
            "{} was purged",
            id_of(record)
        );
    }
}

#[tokio::test]
async fn a_read_only_document_reads_the_record_and_is_refused_the_run() {
    let fixture = TestMcp::start_with(Fixture {
        grant: Grant::Read,
        ..retained_fixture()
    })
    .await;
    let now = Utc::now().timestamp();
    let retained = event(46, 1, now - 30 * 86_400);
    fixture.seed(std::slice::from_ref(&retained)).await;
    let client = fixture.client().await;

    let record = client.call(TOOL_MAINTENANCE_LAST_RUN, json!({})).await;
    assert_eq!(record.is_error, Some(false), "{}", text(&record));
    assert_eq!(payload(&record), json!({ "run": null }));

    let denied = client.call(TOOL_MAINTENANCE_RUN, json!({})).await;
    assert_eq!(denied.is_error, Some(true), "{}", text(&denied));
    assert_eq!(
        text(&denied),
        "Forbidden: maintenance_run needs the \"write\" scope"
    );

    // The read's dispatch line, then the one denial — in call order, and nothing else.
    let entries = fixture.audit_entries();
    assert_eq!(
        actions(&fixture),
        vec![
            audit_action(TOOL_MAINTENANCE_LAST_RUN),
            AUDIT_DENIED.to_owned()
        ],
        "{entries:?}"
    );
    assert_eq!(
        entries[1]["detail"],
        json!({ "tool": TOOL_MAINTENANCE_RUN, "scope": "write" })
    );
    assert!(
        stored(&fixture, &retained).await.is_some(),
        "the denied call reached no store, so the row survives"
    );
}
