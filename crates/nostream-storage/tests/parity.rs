//! Behavioural parity: replays `tests/fixtures/repository-parity.json` through
//! `PostgresBackend` and compares every result with the TypeScript implementation's recording.
//!
//! Run with `--ignored` and `PARITY_ADMIN_URL` set; `scripts/storage-parity.sh` does both.
//! The test creates the database if absent and runs the migrator, so this target and
//! `migrations.rs` have no ordering dependency.
//!
//! The 51 method arms live in `common`, shared with the LMDB arm. What stays here is what
//! only this backend can reach: raw SQL on `users.tos_accepted_at` and the serializable
//! transaction groups.

#![cfg(feature = "postgres")]
// This integration-test target may unwrap: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::Executor;
use sqlx::postgres::PgPool;

use common::{Repos, fixture, settings_from_fixture};
use nostream_storage::postgres::PostgresBackend;
use nostream_storage::repositories::EventRepository;

mod common;

const DATABASE: &str = "nostream_parity_rust";

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

/// One script entry: the two probes this backend owns, then the shared executor.
async fn run_op(
    backend: &PostgresBackend,
    repos: Repos<'_>,
    op: &Value,
    refs: &mut HashMap<String, String>,
) -> Result<Value, nostream_storage::StorageError> {
    if op["op"].as_str() == Some("user.tos_accepted_at") {
        return user_tos_accepted_at(backend, &op["request"]).await;
    }
    common::run_op(repos, op, refs).await
}

/// `users.tos_accepted_at` has no seam form (`fromDBUser` omits the column), so this probe is
/// raw SQL against the master pool and stays in the Postgres arm.
async fn user_tos_accepted_at(
    backend: &PostgresBackend,
    request: &Value,
) -> Result<Value, nostream_storage::StorageError> {
    let pubkey = parse_pubkey(&request["pubkey"]);
    let row = sqlx::query("SELECT tos_accepted_at FROM users WHERE pubkey = $1")
        .bind(pubkey.as_bytes().to_vec())
        .fetch_optional(backend.master())
        .await?;
    let value = match row {
        None => Value::Null,
        Some(row) => {
            let value: Option<chrono::NaiveDateTime> = sqlx::Row::try_get(&row, "tos_accepted_at")?;
            value
                .map(|value| common::iso(&value.and_utc()))
                .unwrap_or(Value::Null)
        }
    };
    Ok(json!({ "value": value }))
}

fn parse_pubkey(value: &Value) -> nostream_core::Pubkey {
    value
        .as_str()
        .expect("a pubkey")
        .parse()
        .expect("a valid pubkey")
}

/// The capture's four serializable transaction groups. Each nested call runs against the
/// transaction for the three traits it carries and against the backend for the rest.
async fn run_transaction(
    backend: &PostgresBackend,
    op: &Value,
    refs: &mut HashMap<String, String>,
) -> Value {
    let ops = op["request"]["ops"].as_array().expect("transaction ops");
    let transaction = backend.begin().await.expect("a serializable transaction");
    let mut results = Vec::new();
    let mut failed_at = None;

    // One map for the whole group: an enqueue's id has to be addressable by the
    // next op in the same transaction, exactly as the top-level script does.
    // A fresh map per nested op loses it, and `mark_delivered` then has no row
    // to address.
    for (index, nested) in ops.iter().enumerate() {
        let repos = Repos {
            invoices: &transaction,
            users: &transaction,
            outbox: &transaction,
            ..Repos::all(backend)
        };
        match run_op(backend, repos, nested, refs).await {
            Ok(result) => results.push(result),
            Err(_) => {
                failed_at = Some(index);
                break;
            }
        }
    }

    match failed_at {
        None => {
            transaction.commit().await.expect("the transaction commits");
            json!({ "failed": false, "results": results })
        }
        Some(index) => {
            drop(transaction);
            json!({ "failed": true, "at": index })
        }
    }
}

/// The TLS feature is compiled in (#911). A server that does not offer TLS has
/// to refuse the upgrade; this build must not refuse it first. With `tls-none`
/// sqlx fails before any handshake with "built without TLS support", which is
/// the regression the feature change closes. A server that does offer TLS is the
/// stronger case: the connection succeeds and `SELECT 1` answers.
#[tokio::test]
#[ignore = "needs PARITY_ADMIN_URL; scripts/storage-parity.sh sets it"]
async fn a_tls_connection_is_attempted_rather_than_refused_by_this_build() {
    let admin = admin_url();
    let base = admin.split('?').next().unwrap_or(admin.as_str());
    let url = format!("{base}?sslmode=require");
    match PgPool::connect(&url).await {
        Ok(pool) => {
            let one: i32 = sqlx::query_scalar("SELECT 1")
                .fetch_one(&pool)
                .await
                .expect("SELECT 1 over TLS");
            assert_eq!(one, 1);
            pool.close().await;
        }
        Err(error) => {
            let message = error.to_string();
            assert!(
                !message.contains("built without TLS support"),
                "sqlx refused to negotiate TLS locally: {message}"
            );
        }
    }
}

/// Run the capture's script against a fresh database created through `admin_url`, and return
/// each op's result in order. The one helper both the plaintext and the TLS leg call, so the
/// two runs differ only in how the connection is made.
async fn replay(admin_url: &str, database: &str) -> Vec<Value> {
    let fixture = fixture();
    let admin = PgPool::connect(admin_url)
        .await
        .expect("the administrative database is reachable");
    admin
        .execute(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS {database} WITH (FORCE)"
        )))
        .await
        .expect("the parity database drops");
    admin
        .execute(sqlx::AssertSqlSafe(format!("CREATE DATABASE {database}")))
        .await
        .expect("the parity database is created");
    drop(admin);

    let backend = PostgresBackend::connect(&with_database(admin_url, database))
        .await
        .expect("the parity database is reachable")
        .with_settings(Arc::new(settings_from_fixture(&fixture)));
    backend.migrate().await.expect("the schema migrates");

    let corpus: Vec<nostream_storage::repositories::EventRecord> = fixture["corpus"]
        .as_array()
        .expect("corpus")
        .iter()
        .map(common::event_record)
        .collect();
    EventRepository::create_many(&backend, &corpus)
        .await
        .expect("the corpus inserts");

    let mut refs = HashMap::new();
    let mut results = Vec::new();
    for (index, op) in fixture["script"]
        .as_array()
        .expect("script")
        .iter()
        .enumerate()
    {
        let name = op["op"].as_str().expect("an op name");
        let actual = if name == "transaction" {
            run_transaction(&backend, op, &mut refs).await
        } else {
            run_op(&backend, Repos::all(&backend), op, &mut refs)
                .await
                .unwrap_or_else(|error| panic!("op {index} ({name}) failed: {error}"))
        };
        results.push(actual);
    }
    results
}

/// Compare each op's result with the TypeScript capture's.
fn assert_matches_capture(actual: &[Value]) {
    let fixture = fixture();
    let script = fixture["script"].as_array().expect("script");
    assert_eq!(actual.len(), script.len(), "the replay ran every op");
    for (index, (op, got)) in script.iter().zip(actual).enumerate() {
        let name = op["op"].as_str().expect("an op name");
        assert_eq!(
            got, &op["result"]["compare"],
            "op {index} ({name}) differs from the TypeScript capture"
        );
    }
}

#[tokio::test]
#[ignore = "needs PARITY_ADMIN_URL; scripts/storage-parity.sh sets it"]
async fn the_typescript_script_replays_with_an_empty_diff() {
    let actual = replay(&admin_url(), DATABASE).await;
    assert_matches_capture(&actual);
}

/// The same script over TLS and over plaintext, compared op by op (#911).
///
/// `sslmode=require` cannot fall back: a build without the TLS feature fails to connect
/// here rather than downgrading, which is the regression the leg exists to catch. The
/// connection-string option is not taken on trust either: `pg_stat_ssl` reports what the
/// server sees for this session, so a silently plaintext connection fails the leg too.
#[tokio::test]
#[ignore = "needs PARITY_TLS_ADMIN_URL; scripts/storage-parity.sh sets it"]
async fn the_same_replay_over_tls_matches_the_capture_and_the_plaintext_run() {
    // CI runs every ignored test with only the plaintext URL, so the leg skips there.
    // scripts/storage-parity.sh sets PARITY_TLS_REQUIRED, under which a skip is a failure:
    // the oracle must not report a green run for a leg that never executed.
    let tls_admin_url = match std::env::var("PARITY_TLS_ADMIN_URL") {
        Ok(url) => url,
        Err(_) if std::env::var_os("PARITY_TLS_REQUIRED").is_some() => {
            panic!("PARITY_TLS_REQUIRED is set but PARITY_TLS_ADMIN_URL is not")
        }
        Err(_) => {
            eprintln!(
                "PARITY_TLS_ADMIN_URL is unset: the TLS leg runs from scripts/storage-parity.sh"
            );
            return;
        }
    };

    let admin = PgPool::connect(&tls_admin_url)
        .await
        .expect("the TLS administrative database is reachable (is ssl=on?)");
    let encrypted: bool =
        sqlx::query_scalar("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
            .fetch_one(&admin)
            .await
            .expect("pg_stat_ssl answers");
    assert!(
        encrypted,
        "the server reports a plaintext session for a sslmode=require URL"
    );
    drop(admin);

    let over_tls = replay(&tls_admin_url, "nostream_parity_tls").await;
    assert_matches_capture(&over_tls);

    let over_plain = replay(&admin_url(), "nostream_parity_plain").await;
    if over_plain != over_tls {
        let index = over_plain
            .iter()
            .zip(&over_tls)
            .position(|(plain, tls)| plain != tls)
            .unwrap_or(0);
        let fixture = fixture();
        let name = fixture["script"]
            .get(index)
            .and_then(|op| op["op"].as_str())
            .unwrap_or("?");
        panic!(
            "op {index} ({name}) differs between plaintext and TLS: plaintext {:?}, TLS {:?}",
            over_plain.get(index),
            over_tls.get(index)
        );
    }
    // Read by scripts/storage-parity.sh with --nocapture as proof the assertions ran.
    println!("TLS_PARITY_COMPLETE");
}
