//! AC3, AC7 — the five store-family tools' oracle: the user row and its balance, the write that
//! leaves the store's own row, the read that must not hydrate, the pending invoice walk, the
//! single invoice, and the review queue — through the protocol a client uses.
//!
//! | case | what it proves |
//! |---|---|
//! | `user_get_answers_the_row_and_its_balance` | the row arrives as the store holds it, and its balance beside it |
//! | `user_get_answers_an_absent_pubkey_with_null_and_zero` | a pubkey with no row is `user: null` and `balance: 0`, not an error |
//! | `user_get_reads_the_stored_flag_and_hydrates_nothing` | a live kind-62 leaves no row behind: the read path is `find_by_pubkey`, never `is_vanished` |
//! | `user_admin_admits_an_uppercase_pubkey_and_the_store_says_so` | the criterion lowercases, and the store — not the payload — carries the admission |
//! | `admitting_a_row_keeps_its_balance` | `admit` writes the row that is there: the invoice's credit survives |
//! | `user_admin_revokes_and_an_absent_pubkey_writes_no_row` | `revoke` clears the flag and creates nothing for a pubkey with no row |
//! | `user_admin_vanishes_and_unvanishes_the_stored_flag` | the minimal row, the tree's only clearing of the flag, and the payload's `action` for all four names the schema publishes |
//! | `vanishing_writes_the_flag_and_deletes_no_event` | the tool is the row write, not the relay's strategy: no event is deleted |
//! | `an_unknown_user_action_never_reaches_the_handler` | the closed set is the arguments type, so nothing is written |
//! | `a_short_pubkey_is_refused_after_its_dispatch_line` | a prefix is refused by the length check before any store call, and its dispatch line exists |
//! | `a_read_only_document_reads_and_is_refused_the_user_write` | the four reads answer under a document that grants nothing, the write is denied and recorded, and no row is written |
//! | `invoices_list_is_the_pending_walk_oldest_first` | the list is the store's pending index, not a status filter: an expired row is absent and still readable by id |
//! | `invoices_list_pages_by_offset_and_refuses_a_page_outside_the_bound` | `offset`/`limit` are the store's own page, 0 and 501 are the one refusal, and the skip ceiling refuses 5001 and serves 5000 |
//! | `invoices_list_serves_the_page_at_the_offset_ceiling` | the page at the ceiling is served, and the bound is on `offset`, not on `offset + limit` |
//! | `invoices_get_answers_the_row_and_a_miss_is_null` | the thirteen fields, and a miss as a result — an id that is 64 hex characters is no different |
//! | `a_confirmed_invoice_still_reads_pending` | confirmation sets the paid fields and leaves the status, and the list keeps naming the row |
//! | `reports_list_is_the_actionable_queue_newest_first` | the queue is `find_actionable`: newest first, and a report an operator allowed is not in it |
//! | `reports_list_refuses_a_page_outside_the_bound` | the queue shares the one page bound |
//! | `user_get_never_calls_the_balance_read` | a users store that refuses `get_balance_by_pubkey` still answers the absent pubkey: the payload's one read is the row |
//!
//! The store is the harness's LMDB backend, seeded the way the storage tests seed it: the
//! repository traits' own writes, so a case reads back through `find_by_pubkey` rather than
//! trusting the payload it just asked for.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use chrono::{DateTime, Utc};
use common::{Fixture, Grant, TestMcp, event, id_of, payload, text};
use nostream_core::{EventId, Filter, Pubkey};
use nostream_mcp::{
    FORBIDDEN, MAX_ROWS_PER_SKIP, TOOL_INVOICES_GET, TOOL_INVOICES_LIST, TOOL_REPORTS_LIST,
    TOOL_USER_ADMIN, TOOL_USER_GET, audit_action,
};
use nostream_storage::repositories::{
    EventRepository, FieldUpdate, Invoice, InvoiceRepository, InvoiceStatus, InvoiceUnit,
    NewReport, Report, ReportRepository, ReportType, User, UserPatch, UserRepository,
};
use serde_json::{Value, json};

/// The published keyspace's `"ab".repeat(32)`, as a pubkey.
fn key() -> Pubkey {
    Pubkey::try_from("ab".repeat(32).as_str()).expect("32 bytes of hex")
}

/// The hex form a case sends, in either case.
fn key_hex() -> String {
    key().to_string()
}

/// An instant at `seconds`, which the store truncates to microseconds.
fn instant(seconds: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(seconds, 0).expect("an instant in range")
}

/// One user row, admitted, written through the trait a case reads back with.
async fn seed_user(fixture: &TestMcp, pubkey: &Pubkey) {
    let patch = UserPatch {
        pubkey: *pubkey,
        is_admitted: FieldUpdate::Set(true),
        is_vanished: FieldUpdate::Absent,
        tos_accepted_at: FieldUpdate::Absent,
    };
    UserRepository::upsert(&*fixture.backend, &patch)
        .await
        .expect("the row stores");
}

/// The stored row, read through `find_by_pubkey` — fully qualified, because the backend answers
/// NIP-05's read of the same name.
async fn stored_user(fixture: &TestMcp, pubkey: &Pubkey) -> Option<User> {
    UserRepository::find_by_pubkey(&*fixture.backend, pubkey)
        .await
        .expect("the user store answers")
}

/// One invoice row, written through the trait the list reads.
async fn seed_invoice(fixture: &TestMcp, invoice: &Invoice) {
    InvoiceRepository::upsert(&*fixture.backend, invoice)
        .await
        .expect("the invoice stores");
}

/// An invoice of `status`, created at `created_at`, requesting `amount_requested` sats.
fn invoice(id: &str, pubkey: &Pubkey, status: InvoiceStatus, created_at: DateTime<Utc>) -> Invoice {
    Invoice {
        id: id.to_owned(),
        pubkey: *pubkey,
        bolt11: format!("lnbc-{id}"),
        amount_requested: 1_000,
        amount_paid: None,
        unit: InvoiceUnit::Sats,
        status,
        description: format!("invoice {id}"),
        confirmed_at: None,
        expires_at: None,
        updated_at: created_at,
        created_at,
        verify_url: None,
    }
}

/// One report row against `pubkey`'s event, with its own event id.
async fn seed_report(
    fixture: &TestMcp,
    report_event: [u8; 32],
    pubkey: &Pubkey,
    reported_event: EventId,
    actionable: bool,
) -> Report {
    let report = NewReport {
        event_id: EventId::from_byte_array(report_event),
        reporter_pubkey: Pubkey::from_byte_array([90; 32]),
        reported_pubkey: Some(*pubkey),
        reported_event_id: Some(reported_event),
        report_type: ReportType::Spam,
        weight: 1.0,
        actionable,
    };
    ReportRepository::create(&*fixture.backend, &report)
        .await
        .expect("the report stores")
}

/// The `id`s a list payload carried, in payload order.
fn ids(payload: &Value, field: &str) -> Vec<String> {
    payload[field]
        .as_array()
        .expect("a list payload")
        .iter()
        .map(|row| row["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[tokio::test]
async fn user_get_answers_the_row_and_its_balance() {
    let fixture = TestMcp::start().await;
    let pubkey = key();
    seed_user(&fixture, &pubkey).await;
    let client = fixture.client().await;

    let result = client
        .call(TOOL_USER_GET, json!({ "pubkey": key_hex() }))
        .await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let answer = payload(&result);
    assert_eq!(answer["user"]["pubkey"], json!(key_hex()), "{answer}");
    assert_eq!(answer["user"]["is_admitted"], true, "{answer}");
    assert_eq!(answer["user"]["is_vanished"], false, "{answer}");
    assert_eq!(answer["user"]["balance"], 0, "{answer}");
    assert_eq!(answer["balance"], 0, "{answer}");
    assert!(
        answer["user"]["created_at"].is_string(),
        "the row's timestamp is the store's: {answer}"
    );
    assert!(
        answer["user"]["updated_at"].is_string(),
        "the row's timestamp is the store's: {answer}"
    );
    assert_eq!(
        answer.as_object().map(serde_json::Map::len),
        Some(2),
        "{answer}"
    );
}

#[tokio::test]
async fn user_get_answers_an_absent_pubkey_with_null_and_zero() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let result = client
        .call(TOOL_USER_GET, json!({ "pubkey": key_hex() }))
        .await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let answer = payload(&result);
    assert!(answer["user"].is_null(), "{answer}");
    assert_eq!(answer["balance"], 0, "{answer}");
    assert!(
        stored_user(&fixture, &key()).await.is_none(),
        "no row exists"
    );
}

#[tokio::test]
async fn user_get_reads_the_stored_flag_and_hydrates_nothing() {
    let fixture = TestMcp::start().await;
    let record = event(77, 62, 1_699_999_700);
    let pubkey = record.event.pubkey;
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;

    let result = client
        .call(TOOL_USER_GET, json!({ "pubkey": pubkey.to_string() }))
        .await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    assert!(
        payload(&result)["user"].is_null(),
        "the flag was never hydrated"
    );
    assert!(
        stored_user(&fixture, &pubkey).await.is_none(),
        "a kind-62 the relay never cached leaves no row: the read path is find_by_pubkey"
    );
}

#[tokio::test]
async fn user_admin_admits_an_uppercase_pubkey_and_the_store_says_so() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let result = client
        .call(
            TOOL_USER_ADMIN,
            json!({ "pubkey": key_hex().to_uppercase(), "action": "admit" }),
        )
        .await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let answer = payload(&result);
    assert_eq!(answer["action"], "admit", "{answer}");
    assert_eq!(answer["user"]["is_admitted"], true, "{answer}");
    assert_eq!(answer["balance"], 0, "{answer}");
    assert_eq!(
        answer.as_object().map(serde_json::Map::len),
        Some(3),
        "{answer}"
    );
    let stored = stored_user(&fixture, &key()).await.expect("the row exists");
    assert!(stored.is_admitted, "the store, not the payload, carries it");
}

#[tokio::test]
async fn admitting_a_row_keeps_its_balance() {
    let fixture = TestMcp::start().await;
    let pubkey = key();
    seed_user(&fixture, &pubkey).await;
    seed_invoice(
        &fixture,
        &invoice(
            "inv-credit",
            &pubkey,
            InvoiceStatus::Pending,
            instant(1_699_999_000),
        ),
    )
    .await;
    InvoiceRepository::confirm_invoice(
        &*fixture.backend,
        "inv-credit",
        1_000,
        instant(1_699_999_800),
    )
    .await
    .expect("the payment confirms");
    let credited = UserRepository::get_balance_by_pubkey(&*fixture.backend, &pubkey)
        .await
        .expect("the balance reads");
    assert_eq!(credited, 1_000_000, "1000 sats credits 1 000 000 msats");

    let client = fixture.client().await;
    let result = client
        .call(
            TOOL_USER_ADMIN,
            json!({ "pubkey": key_hex(), "action": "admit" }),
        )
        .await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let answer = payload(&result);
    assert_eq!(answer["balance"], 1_000_000, "{answer}");
    assert_eq!(answer["user"]["balance"], 1_000_000, "{answer}");
    assert_eq!(answer["user"]["is_admitted"], true, "{answer}");
}

#[tokio::test]
async fn user_admin_revokes_and_an_absent_pubkey_writes_no_row() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let admitted = client
        .call(
            TOOL_USER_ADMIN,
            json!({ "pubkey": key_hex(), "action": "admit" }),
        )
        .await;
    assert_eq!(admitted.is_error, Some(false), "{}", text(&admitted));

    let revoked = client
        .call(
            TOOL_USER_ADMIN,
            json!({ "pubkey": key_hex(), "action": "revoke" }),
        )
        .await;
    assert_eq!(revoked.is_error, Some(false), "{}", text(&revoked));
    let answer = payload(&revoked);
    assert_eq!(answer["action"], "revoke", "{answer}");
    assert_eq!(answer["user"]["is_admitted"], false, "{answer}");
    assert_eq!(answer["balance"], 0, "{answer}");

    let absent = "cd".repeat(32);
    let missed = client
        .call(
            TOOL_USER_ADMIN,
            json!({ "pubkey": absent, "action": "revoke" }),
        )
        .await;
    assert_eq!(missed.is_error, Some(false), "{}", text(&missed));
    let answer = payload(&missed);
    assert!(answer["user"].is_null(), "{answer}");
    assert_eq!(answer["balance"], 0, "{answer}");
    let absent = Pubkey::try_from(absent.as_str()).expect("32 bytes of hex");
    assert!(
        stored_user(&fixture, &absent).await.is_none(),
        "revocation creates nothing"
    );
}

#[tokio::test]
async fn user_admin_vanishes_and_unvanishes_the_stored_flag() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let vanished = client
        .call(
            TOOL_USER_ADMIN,
            json!({ "pubkey": key_hex(), "action": "vanish" }),
        )
        .await;
    assert_eq!(vanished.is_error, Some(false), "{}", text(&vanished));
    let answer = payload(&vanished);
    assert_eq!(answer["action"], "vanish", "{answer}");
    assert_eq!(answer["user"]["is_vanished"], true, "{answer}");
    assert_eq!(
        answer["user"]["is_admitted"], false,
        "the minimal row: {answer}"
    );
    assert_eq!(answer["balance"], 0, "{answer}");
    assert!(
        stored_user(&fixture, &key())
            .await
            .is_some_and(|row| row.is_vanished)
    );

    let unvanished = client
        .call(
            TOOL_USER_ADMIN,
            json!({ "pubkey": key_hex(), "action": "unvanish" }),
        )
        .await;
    assert_eq!(unvanished.is_error, Some(false), "{}", text(&unvanished));
    let answer = payload(&unvanished);
    assert_eq!(answer["action"], "unvanish", "{answer}");
    assert_eq!(answer["user"]["is_vanished"], false, "{answer}");
    assert!(
        stored_user(&fixture, &key())
            .await
            .is_some_and(|row| !row.is_vanished),
        "the flag is cleared in the store, which is what the relay's gate reads"
    );

    // The four names the schema publishes, and the payload's own `action` for each (R4): the
    // enum is read from the same spelling the payload is, so a mistyped arm cannot answer a
    // value outside the contract a validating client checked the call against.
    let tools = client.tools().await;
    let tool = tools
        .iter()
        .find(|tool| tool.name == TOOL_USER_ADMIN)
        .expect("user_admin is listed");
    let schema = Value::Object((*tool.input_schema).clone());
    let advertised: Vec<String> = schema["properties"]["action"]["enum"]
        .as_array()
        .expect("the action enum is published")
        .iter()
        .map(|name| name.as_str().expect("a member is a name").to_owned())
        .collect();
    assert_eq!(
        advertised,
        ["admit", "revoke", "vanish", "unvanish"],
        "{schema}"
    );
    for action in &advertised {
        let answered = client
            .call(
                TOOL_USER_ADMIN,
                json!({ "pubkey": key_hex(), "action": action }),
            )
            .await;
        assert_eq!(answered.is_error, Some(false), "{}", text(&answered));
        let answered = payload(&answered);
        assert_eq!(
            answered["action"],
            json!(action),
            "the payload's action is the schema's member: {answered}"
        );
    }
}

#[tokio::test]
async fn vanishing_writes_the_flag_and_deletes_no_event() {
    let fixture = TestMcp::start().await;
    let record = event(78, 1, 1_699_999_701);
    let id = id_of(&record);
    let pubkey = record.event.pubkey;
    fixture.seed(std::slice::from_ref(&record)).await;
    let client = fixture.client().await;

    let vanished = client
        .call(
            TOOL_USER_ADMIN,
            json!({ "pubkey": pubkey.to_string(), "action": "vanish" }),
        )
        .await;
    assert_eq!(vanished.is_error, Some(false), "{}", text(&vanished));

    let count = fixture
        .backend
        .count_by_filters(&[Filter {
            ids: Some(vec![id]),
            ..Filter::default()
        }])
        .await
        .expect("the store counts");
    assert_eq!(
        count, 1,
        "the event the relay's strategy would have deleted is still stored"
    );
}

#[tokio::test]
async fn an_unknown_user_action_never_reaches_the_handler() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let refused = client
        .call(
            TOOL_USER_ADMIN,
            json!({ "pubkey": key_hex(), "action": "erase" }),
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
async fn a_short_pubkey_is_refused_after_its_dispatch_line() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    let refused = client
        .call(
            TOOL_USER_ADMIN,
            json!({ "pubkey": "abcd", "action": "admit" }),
        )
        .await;
    assert_eq!(refused.is_error, Some(true), "{}", text(&refused));
    assert_eq!(
        text(&refused),
        "pubkey: \"abcd\" is not a 64-character hex pubkey",
        "the length check refuses a prefix before any store call"
    );

    let entries = fixture.audit_entries();
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(
        entries[0]["action"],
        audit_action(TOOL_USER_ADMIN),
        "{entries:?}"
    );

    // The key it would have widened to is absent, so nothing reached the store.
    let widened = Pubkey::try_from("abcd".repeat(16).as_str()).expect("32 bytes of hex");
    assert!(stored_user(&fixture, &widened).await.is_none());
}

#[tokio::test]
async fn a_read_only_document_reads_and_is_refused_the_user_write() {
    let fixture = TestMcp::start_with(Fixture {
        grant: Grant::Read,
        ..Fixture::default()
    })
    .await;
    let record = event(79, 1, 1_699_999_702);
    let pubkey = record.event.pubkey;
    fixture.seed(std::slice::from_ref(&record)).await;
    seed_invoice(
        &fixture,
        &invoice(
            "inv-read",
            &pubkey,
            InvoiceStatus::Pending,
            instant(1_699_999_010),
        ),
    )
    .await;
    let client = fixture.client().await;

    for (tool, arguments) in [
        (TOOL_USER_GET, json!({ "pubkey": pubkey.to_string() })),
        (TOOL_INVOICES_LIST, json!({})),
        (TOOL_INVOICES_GET, json!({ "id": "inv-read" })),
        (TOOL_REPORTS_LIST, json!({})),
    ] {
        let result = client.call(tool, arguments).await;
        assert_eq!(result.is_error, Some(false), "{tool}: {}", text(&result));
    }

    let denied = client
        .call(
            TOOL_USER_ADMIN,
            json!({ "pubkey": pubkey.to_string(), "action": "admit" }),
        )
        .await;
    assert_eq!(denied.is_error, Some(true), "{}", text(&denied));
    let refusal = text(&denied);
    assert!(refusal.contains(FORBIDDEN), "{refusal}");
    assert!(refusal.contains(TOOL_USER_ADMIN), "{refusal}");

    let entries = fixture.audit_entries();
    let actions: Vec<&str> = entries
        .iter()
        .map(|entry| entry["action"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        actions,
        vec![
            audit_action(TOOL_USER_GET).as_str(),
            audit_action(TOOL_INVOICES_LIST).as_str(),
            audit_action(TOOL_INVOICES_GET).as_str(),
            audit_action(TOOL_REPORTS_LIST).as_str(),
            nostream_mcp::AUDIT_DENIED,
        ],
        "{entries:?}"
    );
    assert_eq!(
        entries[4]["detail"],
        json!({ "tool": TOOL_USER_ADMIN, "scope": "write" }),
        "{entries:?}"
    );
    assert!(
        entries[4].get("remoteAddress").is_none(),
        "a stdio caller has no address"
    );
    assert!(
        stored_user(&fixture, &pubkey).await.is_none(),
        "the refused write wrote no row"
    );
}

#[tokio::test]
async fn invoices_list_is_the_pending_walk_oldest_first() {
    let fixture = TestMcp::start().await;
    let pubkey = key();
    for row in [
        invoice(
            "inv-t1",
            &pubkey,
            InvoiceStatus::Pending,
            instant(1_699_999_100),
        ),
        invoice(
            "inv-t2",
            &pubkey,
            InvoiceStatus::Pending,
            instant(1_699_999_200),
        ),
        invoice(
            "inv-expired",
            &pubkey,
            InvoiceStatus::Expired,
            instant(1_699_999_300),
        ),
    ] {
        seed_invoice(&fixture, &row).await;
    }
    let client = fixture.client().await;

    let listed = client.call(TOOL_INVOICES_LIST, json!({})).await;
    assert_eq!(listed.is_error, Some(false), "{}", text(&listed));
    assert_eq!(
        ids(&payload(&listed), "invoices"),
        vec!["inv-t1", "inv-t2"],
        "the pending index, oldest first"
    );

    let single = client
        .call(TOOL_INVOICES_GET, json!({ "id": "inv-expired" }))
        .await;
    assert_eq!(single.is_error, Some(false), "{}", text(&single));
    assert_eq!(payload(&single)["invoice"]["status"], "expired");
}

#[tokio::test]
async fn invoices_list_pages_by_offset_and_refuses_a_page_outside_the_bound() {
    let fixture = TestMcp::start().await;
    let pubkey = key();
    for row in [
        invoice(
            "inv-p1",
            &pubkey,
            InvoiceStatus::Pending,
            instant(1_699_999_100),
        ),
        invoice(
            "inv-p2",
            &pubkey,
            InvoiceStatus::Pending,
            instant(1_699_999_200),
        ),
        invoice(
            "inv-p3",
            &pubkey,
            InvoiceStatus::Pending,
            instant(1_699_999_300),
        ),
    ] {
        seed_invoice(&fixture, &row).await;
    }
    let client = fixture.client().await;

    let paged = client
        .call(TOOL_INVOICES_LIST, json!({ "offset": 1, "limit": 1 }))
        .await;
    assert_eq!(paged.is_error, Some(false), "{}", text(&paged));
    assert_eq!(ids(&payload(&paged), "invoices"), vec!["inv-p2"]);

    for given in [0, 501] {
        let refused = client
            .call(TOOL_INVOICES_LIST, json!({ "limit": given }))
            .await;
        assert_eq!(refused.is_error, Some(true), "{given}: {}", text(&refused));
        assert_eq!(
            text(&refused),
            format!("limit: a page holds between 1 and 500 rows, {given} was given"),
            "{given}"
        );
    }

    let served = client
        .call(TOOL_INVOICES_LIST, json!({ "offset": MAX_ROWS_PER_SKIP }))
        .await;
    assert_eq!(served.is_error, Some(false), "{}", text(&served));
    assert!(ids(&payload(&served), "invoices").is_empty());

    for given in [MAX_ROWS_PER_SKIP + 1, u64::MAX] {
        let refused = client
            .call(TOOL_INVOICES_LIST, json!({ "offset": given }))
            .await;
        assert_eq!(refused.is_error, Some(true), "{given}: {}", text(&refused));
        assert_eq!(
            text(&refused),
            format!("offset: a walk skips at most {MAX_ROWS_PER_SKIP} rows, {given} was given"),
            "{given}"
        );
    }

    let both = client
        .call(
            TOOL_INVOICES_LIST,
            json!({ "limit": 0, "offset": MAX_ROWS_PER_SKIP + 1 }),
        )
        .await;
    assert_eq!(
        text(&both),
        "limit: a page holds between 1 and 500 rows, 0 was given"
    );
}

#[tokio::test]
async fn invoices_list_serves_the_page_at_the_offset_ceiling() {
    let fixture = TestMcp::start().await;
    let pubkey = key();
    for index in 0..=MAX_ROWS_PER_SKIP {
        seed_invoice(
            &fixture,
            &invoice(
                &format!("inv-skip-{index:05}"),
                &pubkey,
                InvoiceStatus::Pending,
                instant(1_699_999_100 + index as i64),
            ),
        )
        .await;
    }
    let client = fixture.client().await;

    let last = client
        .call(
            TOOL_INVOICES_LIST,
            json!({ "offset": MAX_ROWS_PER_SKIP, "limit": 1 }),
        )
        .await;
    assert_eq!(last.is_error, Some(false), "{}", text(&last));
    assert_eq!(ids(&payload(&last), "invoices"), vec!["inv-skip-05000"]);

    let below = MAX_ROWS_PER_SKIP - 1;
    let paged = client
        .call(TOOL_INVOICES_LIST, json!({ "offset": below, "limit": 2 }))
        .await;
    assert_eq!(paged.is_error, Some(false), "{}", text(&paged));
    assert_eq!(
        ids(&payload(&paged), "invoices"),
        vec!["inv-skip-04999", "inv-skip-05000"]
    );
}

#[tokio::test]
async fn invoices_get_answers_the_row_and_a_miss_is_null() {
    let fixture = TestMcp::start().await;
    let pubkey = key();
    seed_invoice(
        &fixture,
        &invoice(
            "inv-1",
            &pubkey,
            InvoiceStatus::Pending,
            instant(1_699_999_100),
        ),
    )
    .await;
    let client = fixture.client().await;

    let found = client
        .call(TOOL_INVOICES_GET, json!({ "id": "inv-1" }))
        .await;
    assert_eq!(found.is_error, Some(false), "{}", text(&found));
    let answer = payload(&found);
    let row = answer["invoice"].as_object().expect("one invoice row");
    assert_eq!(
        row.len(),
        13,
        "the struct's own field count: {}",
        row.keys().cloned().collect::<Vec<_>>().join(", ")
    );
    for field in [
        "id",
        "pubkey",
        "bolt11",
        "amount_requested",
        "amount_paid",
        "unit",
        "status",
        "description",
        "confirmed_at",
        "expires_at",
        "updated_at",
        "created_at",
        "verify_url",
    ] {
        assert!(
            row.contains_key(field),
            "{field} is one of the thirteen: {answer}"
        );
    }
    assert_eq!(answer["invoice"]["unit"], "sats", "{answer}");
    assert_eq!(answer["invoice"]["status"], "pending", "{answer}");
    for field in ["amount_paid", "confirmed_at", "expires_at", "verify_url"] {
        assert!(answer["invoice"][field].is_null(), "{field}: {answer}");
    }

    let missing = client
        .call(TOOL_INVOICES_GET, json!({ "id": "missing" }))
        .await;
    assert_eq!(missing.is_error, Some(false), "{}", text(&missing));
    assert_eq!(payload(&missing), json!({ "invoice": null }));

    // An id that is 64 hex characters is an id: no hex criterion applies to an invoice.
    let hex_id = "ef".repeat(32);
    let accepted = client
        .call(TOOL_INVOICES_GET, json!({ "id": hex_id }))
        .await;
    assert_eq!(accepted.is_error, Some(false), "{}", text(&accepted));
    assert_eq!(payload(&accepted), json!({ "invoice": null }));
}

#[tokio::test]
async fn a_confirmed_invoice_still_reads_pending() {
    let fixture = TestMcp::start().await;
    let pubkey = key();
    seed_user(&fixture, &pubkey).await;
    seed_invoice(
        &fixture,
        &invoice(
            "inv-paid",
            &pubkey,
            InvoiceStatus::Pending,
            instant(1_699_999_100),
        ),
    )
    .await;
    InvoiceRepository::confirm_invoice(
        &*fixture.backend,
        "inv-paid",
        1_000,
        instant(1_699_999_500),
    )
    .await
    .expect("the payment confirms");
    let client = fixture.client().await;

    let read = client
        .call(TOOL_INVOICES_GET, json!({ "id": "inv-paid" }))
        .await;
    assert_eq!(read.is_error, Some(false), "{}", text(&read));
    let answer = payload(&read);
    assert_eq!(answer["invoice"]["status"], "pending", "{answer}");
    assert_eq!(answer["invoice"]["amount_paid"], 1_000, "{answer}");
    assert!(
        answer["invoice"]["confirmed_at"].is_string(),
        "confirmation stamps the instant: {answer}"
    );

    let listed = client.call(TOOL_INVOICES_LIST, json!({})).await;
    assert_eq!(listed.is_error, Some(false), "{}", text(&listed));
    assert_eq!(
        ids(&payload(&listed), "invoices"),
        vec!["inv-paid"],
        "the pending index still holds the confirmed row"
    );
}

#[tokio::test]
async fn reports_list_is_the_actionable_queue_newest_first() {
    let fixture = TestMcp::start().await;
    let pubkey = key();
    let first = seed_report(
        &fixture,
        [0xa1; 32],
        &pubkey,
        EventId::from_byte_array([1; 32]),
        true,
    )
    .await;
    let second = seed_report(
        &fixture,
        [0xb2; 32],
        &pubkey,
        EventId::from_byte_array([2; 32]),
        true,
    )
    .await;
    let allowed = seed_report(
        &fixture,
        [0xc3; 32],
        &pubkey,
        EventId::from_byte_array([3; 32]),
        false,
    )
    .await;
    let client = fixture.client().await;

    let listed = client.call(TOOL_REPORTS_LIST, json!({})).await;
    assert_eq!(listed.is_error, Some(false), "{}", text(&listed));
    let answer = payload(&listed);
    let rows = answer["reports"].as_array().expect("the queue");
    assert_eq!(
        rows.len(),
        2,
        "the non-actionable row is not in the queue: {answer}"
    );
    assert_eq!(rows[0]["id"], second.id, "newest first: {answer}");
    assert_eq!(rows[1]["id"], first.id, "{answer}");
    assert!(
        !rows.iter().any(|row| row["id"] == allowed.id),
        "a report an operator allowed has left the queue: {answer}"
    );
    let still_stored = ReportRepository::find_by_event_id(&*fixture.backend, &allowed.event_id)
        .await
        .expect("the report store answers");
    assert_eq!(
        still_stored.len(),
        1,
        "the row exists: its absence from the list is the list's filter"
    );

    let one = client.call(TOOL_REPORTS_LIST, json!({ "limit": 1 })).await;
    assert_eq!(one.is_error, Some(false), "{}", text(&one));
    let answer = payload(&one);
    let rows = answer["reports"].as_array().expect("the queue");
    assert_eq!(rows.len(), 1, "the bound holds: {answer}");
    assert_eq!(rows[0]["id"], second.id, "and it is the newest: {answer}");
}

#[tokio::test]
async fn reports_list_refuses_a_page_outside_the_bound() {
    let fixture = TestMcp::start().await;
    let client = fixture.client().await;

    for given in [0, 501] {
        let refused = client
            .call(TOOL_REPORTS_LIST, json!({ "limit": given }))
            .await;
        assert_eq!(refused.is_error, Some(true), "{given}: {}", text(&refused));
        assert_eq!(
            text(&refused),
            format!("limit: a page holds between 1 and 500 rows, {given} was given"),
            "{given}"
        );
    }
}

/// The payload's one read, with a store that refuses the removed second: `user_get` on a pubkey
/// with no row answers `user: null` and `balance: 0`, which is only possible when nothing calls
/// `get_balance_by_pubkey`. It proves no second read happens on this path; it cannot prove the
/// two answers would have differed, which with no writer between them they would not (D2).
#[tokio::test]
async fn user_get_never_calls_the_balance_read() {
    let fixture = TestMcp::start_with(Fixture {
        users: Some(std::sync::Arc::new(|backend| {
            std::sync::Arc::new(common::NoBalanceRead::new(backend))
                as std::sync::Arc<dyn UserRepository>
        })),
        ..Fixture::default()
    })
    .await;
    let client = fixture.client().await;

    let result = client
        .call(TOOL_USER_GET, json!({ "pubkey": key_hex() }))
        .await;
    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    assert_eq!(
        payload(&result),
        json!({ "user": null, "balance": 0 }),
        "the row is absent and the balance is the row's own field, so no second read answers it"
    );
}
