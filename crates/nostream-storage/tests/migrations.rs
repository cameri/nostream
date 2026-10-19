//! The schema contract: the 37 sqlx migrations apply cleanly from empty, are idempotent, and
//! produce the same `public` catalogue as the capture's knex migrations.
//!
//! Run with `--ignored` and `PARITY_ADMIN_URL` set (for example
//! `postgres://postgres:postgres@host:port/postgres`); `scripts/storage-parity.sh` does both.
//! The test creates and migrates its own scratch databases, so either database-backed target
//! can run alone.

// This integration-test target may unwrap: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use serde_json::{Value, json};
use sqlx::postgres::PgPool;
use sqlx::{Executor, Row};

use nostream_storage::postgres::{PostgresBackend, migrate_pool};

const RUST_DATABASE: &str = "nostream_parity_rust";
const CUCUMBER_DATABASE: &str = "nostream_parity_cucumber";
const EXPECTED_MIGRATIONS: i64 = 37;

fn admin_url() -> String {
    std::env::var("PARITY_ADMIN_URL").expect(
        "PARITY_ADMIN_URL must name an administrative database, e.g. \
         postgres://postgres:postgres@host:5432/postgres",
    )
}

/// Replaces the database segment of a URL, keeping scheme, authority and parameters.
fn with_database(url: &str, database: &str) -> String {
    assert!(
        database
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'),
        "a scratch database name is interpolated as an identifier"
    );

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

async fn recreate_database(admin: &PgPool, database: &str) {
    admin
        .execute(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS {database} WITH (FORCE)"
        )))
        .await
        .unwrap_or_else(|error| panic!("drop {database}: {error}"));
    admin
        .execute(sqlx::AssertSqlSafe(format!("CREATE DATABASE {database}")))
        .await
        .unwrap_or_else(|error| panic!("create {database}: {error}"));
}

async fn applied_migrations(pool: &PgPool) -> Vec<(i64, bool)> {
    sqlx::query("SELECT version, success FROM _sqlx_migrations ORDER BY version")
        .fetch_all(pool)
        .await
        .expect("the migrations table is readable")
        .iter()
        .map(|row| (row.get::<i64, _>("version"), row.get::<bool, _>("success")))
        .collect()
}

async fn catalogue(pool: &PgPool) -> Value {
    let excluded = "'knex_migrations','knex_migrations_lock','_sqlx_migrations'";

    let columns: Vec<Value> = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT table_name, column_name, ordinal_position::int AS position, data_type, \
         udt_name, is_nullable, column_default, character_maximum_length::int AS max_length, \
         numeric_precision::int AS numeric_precision, numeric_scale::int AS numeric_scale, \
         datetime_precision::int AS datetime_precision \
         FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name NOT IN ({excluded}) \
         ORDER BY table_name, ordinal_position"
    )))
    .fetch_all(pool)
    .await
    .expect("columns are readable")
    .iter()
    .map(|row| {
        json!([
            row.get::<String, _>("table_name"),
            row.get::<String, _>("column_name"),
            row.get::<i32, _>("position"),
            row.get::<String, _>("data_type"),
            row.get::<String, _>("udt_name"),
            row.get::<String, _>("is_nullable"),
            row.get::<Option<String>, _>("column_default"),
            row.get::<Option<i32>, _>("max_length"),
            row.get::<Option<i32>, _>("numeric_precision"),
            row.get::<Option<i32>, _>("numeric_scale"),
            row.get::<Option<i32>, _>("datetime_precision"),
        ])
    })
    .collect();

    let indexes: Vec<Value> = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition \
         FROM pg_indexes WHERE schemaname = 'public' AND tablename NOT IN ({excluded}) \
         ORDER BY tablename, indexname"
    )))
    .fetch_all(pool)
    .await
    .expect("indexes are readable")
    .iter()
    .map(|row| {
        json!([
            row.get::<String, _>("table_name"),
            row.get::<String, _>("index_name"),
            row.get::<String, _>("definition"),
        ])
    })
    .collect();

    let constraints: Vec<Value> = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT c.relname AS table_name, con.conname AS constraint_name, \
         pg_get_constraintdef(con.oid) AS definition \
         FROM pg_constraint con \
         JOIN pg_class c ON c.oid = con.conrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = 'public' AND c.relname NOT IN ({excluded}) \
         ORDER BY c.relname, con.conname"
    )))
    .fetch_all(pool)
    .await
    .expect("constraints are readable")
    .iter()
    .map(|row| {
        json!([
            row.get::<String, _>("table_name"),
            row.get::<String, _>("constraint_name"),
            row.get::<String, _>("definition"),
        ])
    })
    .collect();

    let functions: Vec<Value> = sqlx::query(
        "SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS identity_arguments, \
         pg_get_functiondef(p.oid) AS definition \
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = 'public' \
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') \
         ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)",
    )
    .fetch_all(pool)
    .await
    .expect("functions are readable")
    .iter()
    .map(|row| {
        json!([
            row.get::<String, _>("name"),
            row.get::<String, _>("identity_arguments"),
            row.get::<String, _>("definition"),
        ])
    })
    .collect();

    let triggers: Vec<Value> = sqlx::query(
        "SELECT c.relname AS table_name, t.tgname AS trigger_name, \
         pg_get_triggerdef(t.oid) AS definition \
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE NOT t.tgisinternal AND n.nspname = 'public' \
         ORDER BY c.relname, t.tgname",
    )
    .fetch_all(pool)
    .await
    .expect("triggers are readable")
    .iter()
    .map(|row| {
        json!([
            row.get::<String, _>("table_name"),
            row.get::<String, _>("trigger_name"),
            row.get::<String, _>("definition"),
        ])
    })
    .collect();

    let extensions: Vec<Value> = sqlx::query(
        "SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname",
    )
    .fetch_all(pool)
    .await
    .expect("extensions are readable")
    .iter()
    .map(|row| {
        json!([
            row.get::<String, _>("name"),
            row.get::<String, _>("version"),
        ])
    })
    .collect();

    let sequences: Vec<Value> = sqlx::query(
        "SELECT sequence_name AS name, data_type, start_value::text, minimum_value::text, \
         maximum_value::text, increment::text, cycle_option \
         FROM information_schema.sequences \
         WHERE sequence_schema = 'public' AND sequence_name NOT LIKE 'knex_migrations%' \
         ORDER BY sequence_name",
    )
    .fetch_all(pool)
    .await
    .expect("sequences are readable")
    .iter()
    .map(|row| {
        json!([
            row.get::<String, _>("name"),
            row.get::<String, _>("data_type"),
            row.get::<String, _>("start_value"),
            row.get::<String, _>("minimum_value"),
            row.get::<String, _>("maximum_value"),
            row.get::<String, _>("increment"),
            row.get::<String, _>("cycle_option"),
        ])
    })
    .collect();

    json!({
        "columns": columns,
        "indexes": indexes,
        "constraints": constraints,
        "functions": functions,
        "triggers": triggers,
        "extensions": extensions,
        "sequences": sequences,
    })
}

fn fixture() -> Value {
    let raw = include_str!("fixtures/schema.json");
    serde_json::from_str(raw).expect("tests/fixtures/schema.json is valid JSON")
}

/// Prints the first differing entry per section, so a drift names the object that changed.
fn assert_same(actual: &Value, expected: &Value) {
    for section in [
        "columns",
        "indexes",
        "constraints",
        "functions",
        "triggers",
        "extensions",
        "sequences",
    ] {
        let actual_section = &actual[section];
        let expected_section = &expected[section];
        if actual_section == expected_section {
            continue;
        }
        let actual_len = actual_section.as_array().map_or(0, Vec::len);
        let expected_len = expected_section.as_array().map_or(0, Vec::len);
        let mut first_difference = None;
        for index in 0..actual_len.max(expected_len) {
            let left = actual_section.get(index);
            let right = expected_section.get(index);
            if left != right {
                first_difference = Some((index, left, right));
                break;
            }
        }
        match first_difference {
            Some((index, left, right)) => panic!(
                "schema drift in `{section}` at entry {index} of {actual_len} (expected \
                 {expected_len}):\n  sqlx:  {left:?}\n  knex:  {right:?}"
            ),
            None => panic!("schema drift in `{section}`: {actual_len} vs {expected_len} entries"),
        }
    }
}

#[tokio::test]
#[ignore = "needs PARITY_ADMIN_URL; scripts/storage-parity.sh sets it"]
async fn the_migrations_apply_from_empty_are_idempotent_and_match_the_capture_schema() {
    let admin = PgPool::connect(&admin_url())
        .await
        .expect("the administrative database is reachable");
    recreate_database(&admin, RUST_DATABASE).await;
    recreate_database(&admin, CUCUMBER_DATABASE).await;

    let backend = PostgresBackend::connect(&with_database(&admin_url(), RUST_DATABASE))
        .await
        .expect("the scratch database is reachable");

    migrate_pool(backend.master())
        .await
        .expect("the migrations apply to an empty database");
    let first = applied_migrations(backend.master()).await;
    assert_eq!(
        first.len() as i64,
        EXPECTED_MIGRATIONS,
        "_sqlx_migrations holds one row per migration"
    );
    assert!(
        first.iter().all(|(_, success)| *success),
        "every migration row is successful"
    );

    // A second run changes nothing: same versions, same success flags.
    migrate_pool(backend.master())
        .await
        .expect("a second migration run is a no-op");
    assert_eq!(applied_migrations(backend.master()).await, first);

    let actual = catalogue(backend.master()).await;
    assert_same(&actual, &fixture());

    // The Cucumber target needs the migrated schema too; this target owns that database.
    let cucumber = PgPool::connect(&with_database(&admin_url(), CUCUMBER_DATABASE))
        .await
        .expect("the Cucumber database is reachable");
    migrate_pool(&cucumber)
        .await
        .expect("the migrations apply to the Cucumber database");
    assert_eq!(
        applied_migrations(&cucumber).await.len() as i64,
        EXPECTED_MIGRATIONS
    );
}

#[test]
fn a_scratch_url_replaces_only_the_database() {
    assert_eq!(
        with_database("postgres://u:p@host:5432/postgres", "nostream_parity_rust"),
        "postgres://u:p@host:5432/nostream_parity_rust"
    );
    assert_eq!(
        with_database(
            "postgres://u:p@host:5432/postgres?sslmode=disable",
            "scratch"
        ),
        "postgres://u:p@host:5432/scratch?sslmode=disable"
    );
}
