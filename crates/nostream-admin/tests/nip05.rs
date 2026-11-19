//! The NIP-05 record set the console pages through, and the re-verification that rewrites one
//! row whatever its outcome.
//!
//! | case | what it proves |
//! |---|---|
//! | `the_console_lists_the_stored_records` | a stored record is a listed row, newest check first |
//! | `a_mismatched_reverification_unverifies_the_record` | a definitive failure unverifies the saved row instead of leaving it verified |
//! | `an_errored_reverification_keeps_the_verified_row` | a transient failure keeps the previous verification and only counts the failure |

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use common::{Fixture, NOW_MS, TestServer};
use nostream_core::Pubkey;
use nostream_core::error::CoreError;
use nostream_core::nip05::{FetchOutcome, Nip05Fetch};
use nostream_storage::repositories::Nip05Verification;

/// A fetch seam with one scripted answer, so a verification outcome is chosen by the case.
struct ScriptedFetch {
    status: u16,
    body: String,
}

impl Nip05Fetch for ScriptedFetch {
    fn get<'a>(
        &'a self,
        _url: &'a str,
        _timeout_ms: u64,
        _max_bytes: usize,
        _max_redirects: usize,
    ) -> Pin<Box<dyn Future<Output = Result<FetchOutcome, CoreError>> + Send + 'a>> {
        let outcome = FetchOutcome {
            status: self.status,
            body: self.body.clone().into_bytes(),
        };
        Box::pin(async move { Ok(outcome) })
    }
}

fn at(now_ms: u64) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp_millis(i64::try_from(now_ms).unwrap()).expect("a timestamp")
}

fn record(
    pubkey: &str,
    nip05: &str,
    is_verified: bool,
    last_checked_at: DateTime<Utc>,
) -> Nip05Verification {
    Nip05Verification {
        pubkey: pubkey.parse::<Pubkey>().expect("a pubkey"),
        nip05: nip05.to_owned(),
        domain: nip05.split('@').nth(1).expect("a domain").to_owned(),
        is_verified,
        last_verified_at: is_verified.then_some(last_checked_at),
        last_checked_at,
        failure_count: 0,
        created_at: last_checked_at,
        updated_at: last_checked_at,
    }
}

async fn seed(server: &TestServer, verification: &Nip05Verification) {
    server
        .state
        .stores()
        .nip05
        .upsert(verification)
        .await
        .expect("the record is stored");
}

async fn stored(server: &TestServer, pubkey: &Pubkey) -> Nip05Verification {
    server
        .state
        .stores()
        .nip05
        .find_by_pubkey(pubkey)
        .await
        .expect("the record store")
        .expect("the record")
}

#[tokio::test]
async fn the_console_lists_the_stored_records() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let now = at(NOW_MS);
    let bob = "02".repeat(32);
    let carol = "03".repeat(32);
    let dave = "04".repeat(32);

    let records = [
        record(&bob, "bob@example.com", true, now),
        record(
            &carol,
            "carol@example.org",
            true,
            now - Duration::seconds(60),
        ),
        record(
            &dave,
            "dave@example.net",
            false,
            now - Duration::seconds(120),
        ),
    ];
    for verification in &records {
        seed(&server, verification).await;
    }

    let response = server
        .get_with("/admin/ops/nip05-verifications", &cookie)
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let body = response.json();
    let listed: Vec<String> = body["verifications"]
        .as_array()
        .expect("a verifications list")
        .iter()
        .map(|row| row["pubkey"].as_str().expect("a pubkey").to_owned())
        .collect();
    assert_eq!(
        listed,
        vec![bob.clone(), carol.clone(), dave.clone()],
        "every stored record is listed, newest check first: {}",
        response.text()
    );
    assert_eq!(
        body["pagination"]["total"], 3,
        "the page's total is the record set, not the maintenance queue"
    );
}

#[tokio::test]
async fn a_mismatched_reverification_unverifies_the_record() {
    let pubkey = "02".repeat(32);
    let mut fixture = Fixture::default().with("nip05.mode", serde_json::json!("enabled"));
    fixture.fetch = Some(Arc::new(ScriptedFetch {
        status: 200,
        body: format!(r#"{{"names":{{"bob":"{}"}}}}"#, "03".repeat(32)),
    }));
    let server = TestServer::start_with(fixture).await;
    let cookie = server.login().await;
    let seeded = record(&pubkey, "bob@example.com", true, at(NOW_MS));
    seed(&server, &seeded).await;

    let response = server
        .send_json(
            "POST",
            &format!("/admin/ops/nip05-verifications/{pubkey}/reverify"),
            &cookie,
            serde_json::json!({}),
        )
        .await;
    assert_eq!(response.status, 502, "{}", response.text());
    assert_eq!(response.json()["error"], "Re-verification failed");

    let saved = stored(&server, &seeded.pubkey).await;
    assert!(
        !saved.is_verified,
        "a mismatch is definitive: the stored row is no longer verified"
    );
    assert_eq!(
        saved.last_verified_at, None,
        "a mismatch clears the last verification"
    );
    assert_eq!(
        saved.failure_count, 1,
        "the failure is counted on the saved row"
    );
    assert_eq!(
        saved.last_checked_at,
        at(NOW_MS),
        "the check time moves with the outcome"
    );
}

#[tokio::test]
async fn an_errored_reverification_keeps_the_verified_row() {
    let pubkey = "02".repeat(32);
    let mut fixture = Fixture::default().with("nip05.mode", serde_json::json!("enabled"));
    fixture.fetch = Some(Arc::new(ScriptedFetch {
        status: 500,
        body: String::new(),
    }));
    let server = TestServer::start_with(fixture).await;
    let cookie = server.login().await;
    let verified_at = at(NOW_MS);
    let seeded = record(&pubkey, "bob@example.com", true, verified_at);
    seed(&server, &seeded).await;

    let response = server
        .send_json(
            "POST",
            &format!("/admin/ops/nip05-verifications/{pubkey}/reverify"),
            &cookie,
            serde_json::json!({}),
        )
        .await;
    assert_eq!(response.status, 502, "{}", response.text());

    let saved = stored(&server, &seeded.pubkey).await;
    assert!(
        saved.is_verified,
        "a transient error keeps a verified author verified"
    );
    assert_eq!(
        saved.last_verified_at,
        Some(verified_at),
        "the last verification is untouched by a transient error"
    );
    assert_eq!(
        saved.failure_count, 1,
        "the failure is counted so the backoff can see it"
    );
}
