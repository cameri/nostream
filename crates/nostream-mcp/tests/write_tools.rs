//! The two write tools' oracle: every outcome a delete can answer, the read-back the payload
//! discloses, the gate moving under `hide`/`allow`, and the two refusal paths — through the
//! protocol a client uses.
//!
//! | case | what it proves |
//! |---|---|
//! | `a_first_delete_marks_the_row_and_says_so` | a live row is marked deleted, the payload carries the store's own `deleted_at`, and both event tools still return it |
//! | `a_second_delete_says_already_deleted` | the store skips the second call and the timestamp does not move |
//! | `a_prefix_is_not_an_id_and_deletes_nothing` | a four-character prefix names no event and deletes nothing |
//! | `an_unknown_id_is_not_found_not_an_error` | an id nothing carries is a result, not an error |
//! | `a_request_to_vanish_is_never_deleted` | kind 62 is the store's own skip, and the payload says which row it was |
//! | `a_deleted_event_leaves_the_counts` | a soft delete leaves COUNT, through the door's own call |
//! | `a_read_only_document_is_refused_both_writes` | both writes are refused by name, two `mcp.denied` lines are written, and nothing moved |
//! | `allowing_a_report_returns_its_target_to_the_listing` | `allow` flips the row and all three indexes, so the event comes back to a REQ |
//! | `hiding_a_report_withholds_its_target_again` | `hide` puts it back |
//! | `a_second_allow_changes_nothing` | a value that already holds is not written and not counted |
//! | `every_row_of_one_report_event_moves` | one report event writes one row per target, and one call moves them all |
//! | `an_unknown_report_is_an_empty_answer` | an id with no rows answers an empty list and zero |
//! | `a_report_id_that_is_not_an_exact_id_is_refused` | a short id is refused by the handler, after its dispatch line |
//! | `an_unknown_action_never_reaches_the_handler` | the closed set is the arguments type, so nothing is written |
//! | `an_allow_leaves_a_target_another_report_still_hides` | the action is one row's flag: another actionable report keeps the target hidden |
//! | `a_mixed_report_counts_only_the_rows_that_moved` | `changed` counts the rows that moved, and the payload lists every row of the event |
//!
//! Three fixtures carry the NIP-56 gate on (`nip56.enabled` and `nip56.hideActionableReports`),
//! which is the only way the setter's index work is observable. Cases that seed a report row
//! without the gate still exercise the write and the row's flag; what they cannot see is the
//! NIP-56 filter, because their settings leave `nip56.enabled` off and the gate never fires.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::{Fixture, Grant, TestMcp, event, id_of, payload, text};
use nostream_core::{EventId, Filter, Pubkey};
use nostream_mcp::{
    AUDIT_DENIED, FORBIDDEN, OUTCOME_ALREADY_DELETED, OUTCOME_DELETED, OUTCOME_NOT_DELETEABLE,
    OUTCOME_NOT_FOUND, TOOL_DELETE_EVENT, TOOL_GET_EVENT, TOOL_LIST_EVENTS, TOOL_REPORTS_ACTION,
};
use nostream_storage::repositories::{
    ActionableTarget, EventRepository, NewReport, Report, ReportRepository, ReportType,
    StorageFuture, collect_records,
};
use serde_json::{Value, json};

/// The `ids` a `list_events` answer carried, in payload order.
fn listed(payload: &Value) -> Vec<String> {
    payload["events"]
        .as_array()
        .expect("a list_events payload")
        .iter()
        .map(|event| event["event"]["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// One `list_events` call for a kind, and the ids it answered.
async fn listing(client: &common::Mcp, kinds: &[u64]) -> Vec<String> {
    let result = client
        .call(TOOL_LIST_EVENTS, json!({ "kinds": kinds }))
        .await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    listed(&payload(&result))
}

/// An actionable report row naming `record`'s pubkey and id, keyed by its own event id.
async fn seed_report(
    fixture: &TestMcp,
    report_event: [u8; 32],
    record: &nostream_storage::repositories::EventRecord,
) {
    let report = NewReport {
        event_id: EventId::from_byte_array(report_event),
        reporter_pubkey: Pubkey::from_byte_array([90; 32]),
        reported_pubkey: Some(record.event.pubkey),
        reported_event_id: Some(record.event.id),
        report_type: ReportType::Spam,
        weight: 1.0,
        actionable: true,
    };
    ReportRepository::create(&*fixture.backend, &report)
        .await
        .expect("the report stores");
}

#[tokio::test]
async fn a_first_delete_marks_the_row_and_says_so() {
    let fixture = TestMcp::start().await;
    let record = event(21, 1, 1_699_999_960);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;

    let deleted = client.call(TOOL_DELETE_EVENT, json!({ "id": id })).await;
    assert_eq!(deleted.is_error, Some(false), "{}", text(&deleted));
    let answer = payload(&deleted);
    assert_eq!(answer["outcome"], OUTCOME_DELETED, "{answer}");
    assert!(
        answer["event"]["deleted_at"].is_string(),
        "the payload carries the store's own deletion time: {answer}"
    );
    assert_eq!(answer["event"]["event"]["id"], json!(id), "{answer}");
    let first = answer["event"]["deleted_at"].clone();

    // R5's disclosure, checked rather than asserted in prose: the row is still readable by both
    // event tools, with its deletion time.
    let read = client.call(TOOL_GET_EVENT, json!({ "id": id })).await;
    assert_eq!(read.is_error, Some(false), "{}", text(&read));
    assert_eq!(payload(&read)["event"]["deleted_at"], first);

    let listing = client.call(TOOL_LIST_EVENTS, json!({ "ids": [id] })).await;
    assert_eq!(listing.is_error, Some(false), "{}", text(&listing));
    let events = payload(&listing)["events"].as_array().unwrap().clone();
    assert_eq!(events.len(), 1, "one row, still listed: {events:?}");
    assert_eq!(events[0]["deleted_at"], first);
}

#[tokio::test]
async fn a_second_delete_says_already_deleted() {
    let fixture = TestMcp::start().await;
    let record = event(22, 1, 1_699_999_961);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;

    let first = payload(&client.call(TOOL_DELETE_EVENT, json!({ "id": id })).await);
    let second = payload(&client.call(TOOL_DELETE_EVENT, json!({ "id": id })).await);
    assert_eq!(second["outcome"], OUTCOME_ALREADY_DELETED, "{second}");
    assert_eq!(
        second["event"]["deleted_at"], first["event"]["deleted_at"],
        "the second call does not move the timestamp: {first} {second}"
    );
}

#[tokio::test]
async fn a_prefix_is_not_an_id_and_deletes_nothing() {
    let fixture = TestMcp::start().await;
    let record = event(23, 1, 1_699_999_962);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;

    let prefix = &id[..4];
    let deleted = client
        .call(TOOL_DELETE_EVENT, json!({ "id": prefix }))
        .await;
    assert_eq!(deleted.is_error, Some(false), "{}", text(&deleted));
    let answer = payload(&deleted);
    assert_eq!(answer["outcome"], OUTCOME_NOT_FOUND, "{answer}");
    assert!(answer["event"].is_null(), "a prefix names no row: {answer}");

    let read = client.call(TOOL_GET_EVENT, json!({ "id": id })).await;
    assert!(
        payload(&read)["event"]["deleted_at"].is_null(),
        "the row the prefix widened to is untouched: {}",
        payload(&read)
    );
}

#[tokio::test]
async fn an_unknown_id_is_not_found_not_an_error() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let deleted = client
        .call(TOOL_DELETE_EVENT, json!({ "id": "ab".repeat(32) }))
        .await;
    assert_eq!(deleted.is_error, Some(false), "{}", text(&deleted));
    let answer = payload(&deleted);
    assert_eq!(answer["outcome"], OUTCOME_NOT_FOUND, "{answer}");
    assert!(answer["event"].is_null(), "{answer}");
}

#[tokio::test]
async fn a_request_to_vanish_is_never_deleted() {
    let fixture = TestMcp::start().await;
    let record = event(24, 62, 1_699_999_963);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;

    let deleted = client.call(TOOL_DELETE_EVENT, json!({ "id": id })).await;
    let answer = payload(&deleted);
    assert_eq!(answer["outcome"], OUTCOME_NOT_DELETEABLE, "{answer}");
    assert_eq!(answer["event"]["event"]["kind"], 62, "{answer}");
    assert!(answer["event"]["deleted_at"].is_null(), "{answer}");

    let read = client.call(TOOL_GET_EVENT, json!({ "id": id })).await;
    assert!(payload(&read)["event"]["deleted_at"].is_null());
}

#[tokio::test]
async fn a_deleted_event_leaves_the_counts() {
    let fixture = TestMcp::start().await;
    let record = event(25, 1, 1_699_999_964);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;

    let filters = [Filter {
        ids: Some(vec![id.clone()]),
        ..Filter::default()
    }];
    assert_eq!(
        fixture.backend.count_by_filters(&filters).await.unwrap(),
        1,
        "the row is counted to begin with"
    );

    let deleted = client.call(TOOL_DELETE_EVENT, json!({ "id": id })).await;
    assert_eq!(payload(&deleted)["outcome"], OUTCOME_DELETED);

    assert_eq!(
        fixture.backend.count_by_filters(&filters).await.unwrap(),
        0,
        "COUNT applies the live predicate (V13)"
    );
}

#[tokio::test]
async fn a_read_only_document_is_refused_both_writes() {
    let fixture = TestMcp::start_with(Fixture {
        grant: Grant::Read,
        ..Fixture::default()
    })
    .await;
    let record = event(26, 1, 1_699_999_965);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let report_id = EventId::from_byte_array([46; 32]).to_string();
    seed_report(&fixture, [46; 32], &record).await;
    let client = fixture.client().await;

    let deleted = client.call(TOOL_DELETE_EVENT, json!({ "id": id })).await;
    let acted = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": report_id, "action": "allow" }),
        )
        .await;

    // The state is asserted before the refusals, so the subject of "nothing ran" is a row the
    // call would have moved: `allow` at an actionable row is a write, `hide` at one is a skip
    // the store does not perform.
    let rows = collect_records(
        fixture
            .backend
            .find_by_filters(&[Filter {
                ids: Some(vec![id.clone()]),
                ..Filter::default()
            }])
            .await
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert!(
        rows[0].deleted_at.is_none(),
        "the refused delete moved nothing"
    );
    let reports = fixture
        .backend
        .find_by_event_id(&EventId::from_byte_array([46; 32]))
        .await
        .unwrap();
    assert_eq!(reports.len(), 1, "the report row the refused call named");
    assert!(
        reports[0].actionable,
        "the refused report action moved nothing: {reports:?}"
    );

    for (tool, refused) in [(TOOL_DELETE_EVENT, &deleted), (TOOL_REPORTS_ACTION, &acted)] {
        assert_eq!(refused.is_error, Some(true), "{tool}");
        let refusal = text(refused);
        assert!(refusal.contains(FORBIDDEN), "{tool}: {refusal}");
        assert!(refusal.contains(tool), "{tool}: {refusal}");
    }

    let entries = fixture.audit_entries();
    let actions: Vec<&str> = entries
        .iter()
        .map(|entry| entry["action"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(actions, vec![AUDIT_DENIED, AUDIT_DENIED], "{entries:?}");
    for entry in &entries {
        assert_eq!(entry["detail"]["scope"], "write", "{entry}");
        assert!(entry["detail"]["tool"].as_str().is_some(), "{entry}");
        assert!(
            entry.get("remoteAddress").is_none(),
            "a stdio caller has no address: {entry}"
        );
    }
}

#[tokio::test]
async fn allowing_a_report_returns_its_target_to_the_listing() {
    let fixture = TestMcp::start_with(
        Fixture::default()
            .with("nip56.enabled", json!(true))
            .with("nip56.hideActionableReports", json!(true)),
    )
    .await;
    let record = event(27, 1, 1_699_999_966);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let report_id = EventId::from_byte_array([47; 32]).to_string();
    seed_report(&fixture, [47; 32], &record).await;
    let client = fixture.client().await;

    assert!(
        !listing(&client, &[1]).await.contains(&id),
        "the gate withholds the reported event"
    );

    let acted = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": report_id, "action": "allow" }),
        )
        .await;
    assert_eq!(acted.is_error, Some(false), "{}", text(&acted));
    let answer = payload(&acted);
    assert_eq!(answer["changed"], 1, "{answer}");
    assert_eq!(answer["reports"][0]["actionable"], false, "{answer}");

    assert!(
        listing(&client, &[1]).await.contains(&id),
        "the event returns to a REQ once the row stops being actionable"
    );
    assert!(
        fixture
            .backend
            .find_actionable_targets()
            .await
            .unwrap()
            .is_empty(),
        "the index entry is gone, not only the row's flag"
    );
    assert!(
        fixture
            .backend
            .find_actionable(10)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn hiding_a_report_withholds_its_target_again() {
    let fixture = TestMcp::start_with(
        Fixture::default()
            .with("nip56.enabled", json!(true))
            .with("nip56.hideActionableReports", json!(true)),
    )
    .await;
    let record = event(28, 1, 1_699_999_967);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let report_id = EventId::from_byte_array([48; 32]).to_string();
    seed_report(&fixture, [48; 32], &record).await;
    let client = fixture.client().await;

    let allowed = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": report_id, "action": "allow" }),
        )
        .await;
    assert_eq!(payload(&allowed)["changed"], 1);
    assert!(listing(&client, &[1]).await.contains(&id));

    let hidden = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": report_id, "action": "hide" }),
        )
        .await;
    assert_eq!(hidden.is_error, Some(false), "{}", text(&hidden));
    let answer = payload(&hidden);
    assert_eq!(answer["changed"], 1, "{answer}");
    assert_eq!(answer["reports"][0]["actionable"], true, "{answer}");
    assert!(
        !listing(&client, &[1]).await.contains(&id),
        "the gate withholds it again: the index entry came back with the flag"
    );
}

#[tokio::test]
async fn a_second_allow_changes_nothing() {
    let fixture = TestMcp::start().await;
    let record = event(29, 1, 1_699_999_968);
    fixture.seed(std::slice::from_ref(&record)).await;
    let report_id = EventId::from_byte_array([49; 32]).to_string();
    seed_report(&fixture, [49; 32], &record).await;
    let client = fixture.client().await;

    let first = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": report_id, "action": "allow" }),
        )
        .await;
    assert_eq!(payload(&first)["changed"], 1);

    let second = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": report_id, "action": "allow" }),
        )
        .await;
    assert_eq!(second.is_error, Some(false), "{}", text(&second));
    let answer = payload(&second);
    assert_eq!(answer["changed"], 0, "{answer}");
    assert_eq!(answer["reports"][0]["actionable"], false, "{answer}");
    assert_eq!(answer["reports"].as_array().unwrap().len(), 1, "{answer}");
}

/// A report store that answers one event's rows **newest id first**, which is not the order the
/// handler must publish. LMDB walks `(event_id, report_id)` ascending by construction, so a case
/// reading the real store cannot tell a sorted payload from an unsorted one; every other method is
/// the backend's own.
struct NewestFirst(Arc<dyn ReportRepository>);

impl ReportRepository for NewestFirst {
    fn create<'a>(&'a self, report: &'a NewReport) -> StorageFuture<'a, Report> {
        self.0.create(report)
    }

    fn create_many<'a>(&'a self, reports: &'a [NewReport]) -> StorageFuture<'a, Vec<Report>> {
        self.0.create_many(reports)
    }

    fn find_by_event_id<'a>(&'a self, event_id: &'a EventId) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async move {
            let mut rows = self.0.find_by_event_id(event_id).await?;
            rows.reverse();
            Ok(rows)
        })
    }

    fn find_actionable<'a>(&'a self, limit: u64) -> StorageFuture<'a, Vec<Report>> {
        self.0.find_actionable(limit)
    }

    fn find_actionable_targets<'a>(&'a self) -> StorageFuture<'a, Vec<ActionableTarget>> {
        self.0.find_actionable_targets()
    }

    fn set_actionable<'a>(
        &'a self,
        event_id: &'a EventId,
        actionable: bool,
    ) -> StorageFuture<'a, u64> {
        self.0.set_actionable(event_id, actionable)
    }
}

#[tokio::test]
async fn every_row_of_one_report_event_moves() {
    let fixture = TestMcp::start_with(Fixture {
        reports: Some(Arc::new(|backend| {
            Arc::new(NewestFirst(backend)) as Arc<dyn ReportRepository>
        })),
        ..Fixture::default()
    })
    .await;
    let one = event(30, 1, 1_699_999_969);
    let two = event(31, 1, 1_699_999_970);
    fixture.seed(&[one.clone(), two.clone()]).await;
    let report_id = EventId::from_byte_array([50; 32]);
    let rows = [
        NewReport {
            event_id: report_id,
            reporter_pubkey: Pubkey::from_byte_array([91; 32]),
            reported_pubkey: Some(one.event.pubkey),
            reported_event_id: Some(one.event.id),
            report_type: ReportType::Spam,
            weight: 1.0,
            actionable: true,
        },
        NewReport {
            event_id: report_id,
            reporter_pubkey: Pubkey::from_byte_array([91; 32]),
            reported_pubkey: Some(two.event.pubkey),
            reported_event_id: Some(two.event.id),
            report_type: ReportType::Spam,
            weight: 1.0,
            actionable: true,
        },
    ];
    ReportRepository::create_many(&*fixture.backend, &rows)
        .await
        .expect("the two report rows store");
    let client = fixture.client().await;

    let acted = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": report_id.to_string(), "action": "allow" }),
        )
        .await;
    assert_eq!(acted.is_error, Some(false), "{}", text(&acted));
    let answer = payload(&acted);
    assert_eq!(answer["changed"], 2, "{answer}");
    let reports = answer["reports"].as_array().unwrap();
    assert_eq!(reports.len(), 2, "{answer}");
    assert!(reports.iter().all(|row| row["actionable"] == false));
    let ids: Vec<i64> = reports
        .iter()
        .map(|row| row["id"].as_i64().expect("a report id"))
        .collect();
    assert!(ids[0] < ids[1], "the payload is ordered by `id`: {ids:?}");
}

#[tokio::test]
async fn an_unknown_report_is_an_empty_answer() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let acted = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": "ab".repeat(32), "action": "hide" }),
        )
        .await;
    assert_eq!(acted.is_error, Some(false), "{}", text(&acted));
    let answer = payload(&acted);
    assert_eq!(answer["reports"], json!([]), "{answer}");
    assert_eq!(answer["changed"], 0, "{answer}");
}

#[tokio::test]
async fn a_report_id_that_is_not_an_exact_id_is_refused() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let refused = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": "abcd", "action": "hide" }),
        )
        .await;
    assert_eq!(refused.is_error, Some(true));
    assert_eq!(
        text(&refused),
        "id: \"abcd\" is not a 64-character hex id",
        "the handler's own sentence"
    );

    // The dispatch line precedes the handler's refusal, so the file carries exactly one.
    let entries = fixture.audit_entries();
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0]["action"], "mcp.reports_action", "{entries:?}");
}

#[tokio::test]
async fn an_unknown_action_never_reaches_the_handler() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let refused = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": "ab".repeat(32), "action": "maybe" }),
        )
        .await;
    assert_eq!(refused.is_error, Some(true), "{}", text(&refused));
    assert!(
        fixture.audit_entries().is_empty(),
        "the arguments type refuses it before dispatch: {:?}",
        fixture.audit_entries()
    );
}

#[tokio::test]
async fn an_allow_leaves_a_target_another_report_still_hides() {
    let fixture = TestMcp::start_with(
        Fixture::default()
            .with("nip56.enabled", json!(true))
            .with("nip56.hideActionableReports", json!(true)),
    )
    .await;
    let record = event(32, 1, 1_699_999_971);
    let id = id_of(&record);
    fixture.seed(std::slice::from_ref(&record)).await;
    let first = EventId::from_byte_array([62; 32]).to_string();
    let second = EventId::from_byte_array([63; 32]).to_string();
    seed_report(&fixture, [62; 32], &record).await;
    seed_report(&fixture, [63; 32], &record).await;
    let client = fixture.client().await;

    let allowed = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": first, "action": "allow" }),
        )
        .await;
    assert_eq!(allowed.is_error, Some(false), "{}", text(&allowed));
    assert_eq!(payload(&allowed)["changed"], 1, "one report's rows");
    assert!(
        !listing(&client, &[1]).await.contains(&id),
        "the other actionable report still names the target, so it stays hidden"
    );

    let both = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": second, "action": "allow" }),
        )
        .await;
    assert_eq!(payload(&both)["changed"], 1);
    assert!(
        listing(&client, &[1]).await.contains(&id),
        "no actionable report names it now"
    );
}

#[tokio::test]
async fn a_mixed_report_counts_only_the_rows_that_moved() {
    let fixture = TestMcp::start().await;
    let record = event(33, 1, 1_699_999_972);
    fixture.seed(std::slice::from_ref(&record)).await;
    let report_event = EventId::from_byte_array([64; 32]);
    ReportRepository::create_many(
        &*fixture.backend,
        &[
            NewReport {
                event_id: report_event,
                reporter_pubkey: Pubkey::from_byte_array([92; 32]),
                reported_pubkey: Some(record.event.pubkey),
                reported_event_id: None,
                report_type: ReportType::Spam,
                weight: 1.0,
                actionable: false,
            },
            NewReport {
                event_id: report_event,
                reporter_pubkey: Pubkey::from_byte_array([92; 32]),
                reported_pubkey: None,
                reported_event_id: Some(record.event.id),
                report_type: ReportType::Spam,
                weight: 1.0,
                actionable: true,
            },
        ],
    )
    .await
    .expect("the report rows store");
    let client = fixture.client().await;

    let acted = client
        .call(
            TOOL_REPORTS_ACTION,
            json!({ "id": report_event.to_string(), "action": "allow" }),
        )
        .await;
    assert_eq!(acted.is_error, Some(false), "{}", text(&acted));
    let answer = payload(&acted);
    assert_eq!(
        answer["changed"], 1,
        "only the row whose value moved is counted: {answer}"
    );
    let reports = answer["reports"].as_array().unwrap();
    assert_eq!(reports.len(), 2, "both rows are listed: {answer}");
    assert!(reports.iter().all(|row| row["actionable"] == false));
}
