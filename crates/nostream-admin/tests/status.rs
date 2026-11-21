//! AC6 — the relay status document's assembly, its atomic write and its three reasons.
//!
//! | case | what it proves |
//! |---|---|
//! | `the_document_carries_the_daemons_three_facts` | uptime, the connection count passed in, and the console's own worker rows |
//! | `a_written_document_reads_back` | the round trip at one instant, and no `.tmp` left behind |
//! | `a_document_at_the_bound_is_fresh_and_one_past_it_is_not` | 30 s is fresh, 31 s is not |
//! | `a_missing_document_is_a_reason` | absent: a reason naming the file |
//! | `an_unreadable_document_is_a_reason` | a wrong-typed key: a reason naming the file, not a guess |
//! | `a_missing_config_directory_is_created` | the write creates `<config>`, as the audit log's does |
//! | `a_racing_reader_never_sees_a_partial_document` | every completed read is one whole document while a writer replaces it |

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{NOW_MS, TestServer, repo_root};
use nostream_admin::state::iso8601;
use nostream_admin::utils::status::{self, STATUS_TTL_SECONDS, StatusDocument};
use nostream_admin::utils::workers::{self, WorkerRow};
use nostream_config::SettingsPaths;
use nostream_core::Clock;

#[tokio::test]
async fn the_document_carries_the_daemons_three_facts() {
    let server = TestServer::start().await;
    server.clock.advance(60_000);

    let document = status::collect(&server.state, 7).expect("a document");
    let settings = server.state.settings().expect("the fixture settings");

    assert_eq!(document.uptime_seconds, 60, "the state's own age");
    assert_eq!(document.active_connections, 7, "the number passed in");
    assert_eq!(
        document.workers,
        workers::rows(&server.state, &settings),
        "the console's rows, row for row"
    );
    assert_eq!(document.generated_at, iso8601(server.clock.now_ms()));
}

#[tokio::test]
async fn a_written_document_reads_back() {
    let server = TestServer::start().await;
    let document = status::collect(&server.state, 3).expect("a document");
    let path = status::path(server.state.paths());

    status::write(&path, &document).expect("a write");
    let published = status::read(server.state.paths(), server.clock.now_ms()).expect("a read");

    assert_eq!(published.document, document);
    assert_eq!(published.age_seconds, 0);

    let names: Vec<String> = std::fs::read_dir(&server.config_dir)
        .expect("the config dir")
        .map(|entry| {
            entry
                .expect("an entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert!(
        !names.iter().any(|name| name.ends_with(".tmp")),
        "no staging file survives a successful write: {names:?}"
    );
}

#[tokio::test]
async fn a_document_at_the_bound_is_fresh_and_one_past_it_is_not() {
    let server = TestServer::start().await;
    let document = status::collect(&server.state, 0).expect("a document");
    status::write(&status::path(server.state.paths()), &document).expect("a write");

    let at_the_bound = NOW_MS + STATUS_TTL_SECONDS * 1_000;
    let published = status::read(server.state.paths(), at_the_bound).expect("30 s is fresh");
    assert_eq!(published.age_seconds, STATUS_TTL_SECONDS);

    let past_it = NOW_MS + (STATUS_TTL_SECONDS + 1) * 1_000;
    let error = status::read(server.state.paths(), past_it).expect_err("31 s is not fresh");

    assert!(
        error.reason.contains("relay-status.json"),
        "{}",
        error.reason
    );
    assert!(
        error.reason.contains("31 seconds old"),
        "the reason states the age: {}",
        error.reason
    );
}

#[tokio::test]
async fn a_missing_document_is_a_reason() {
    let server = TestServer::start().await;

    let error = status::read(server.state.paths(), NOW_MS).expect_err("there is no document");

    assert!(
        error.reason.contains("relay-status.json"),
        "{}",
        error.reason
    );
    assert!(
        error.reason.starts_with("no relay status document at"),
        "{}",
        error.reason
    );
}

#[tokio::test]
async fn an_unreadable_document_is_a_reason() {
    let server = TestServer::start().await;
    std::fs::write(
        status::path(server.state.paths()),
        r#"{"activeConnections": "seven"}"#,
    )
    .expect("a written file");

    let error =
        status::read(server.state.paths(), NOW_MS).expect_err("the document does not parse");

    assert!(
        error.reason.contains("relay-status.json"),
        "{}",
        error.reason
    );
    assert!(
        error.reason.contains("could not be read"),
        "{}",
        error.reason
    );
}

#[tokio::test]
async fn a_missing_config_directory_is_created() {
    let temp = tempfile::tempdir().expect("a temp dir");
    let config_dir = temp.path().join("config");
    let paths = SettingsPaths::from_config_dir(&repo_root(), &config_dir);
    let document = StatusDocument {
        generated_at: iso8601(NOW_MS),
        uptime_seconds: 1,
        active_connections: 2,
        workers: Vec::new(),
    };

    assert!(!config_dir.exists(), "the fixture starts without a config dir");
    status::write(&status::path(&paths), &document).expect("the write creates the directory");

    assert!(config_dir.is_dir(), "the write created the config dir");
    let published = status::read(&paths, NOW_MS).expect("the document reads back");
    assert_eq!(published.document, document);
}

/// One `WorkerRow` per index, so a document's body can be made large or small on demand.
fn document_with_workers(rows: usize) -> StatusDocument {
    StatusDocument {
        generated_at: iso8601(NOW_MS),
        uptime_seconds: 1,
        active_connections: 2,
        workers: (0..rows)
            .map(|index| WorkerRow {
                worker_type: "worker".to_owned(),
                index: Some(index.to_string()),
                enabled: true,
                label: format!("Client worker {index}"),
                heartbeat: None,
                monitored: false,
                stale: false,
            })
            .collect(),
    }
}

/// The atomic replace, seen from the outside: a writer alternates a large and a small document
/// while a reader takes every read the file allows, and every completed read is one of the two
/// whole documents. A direct `std::fs::write` truncates before it writes, so the reader meets a
/// partial document and its parse or its equality fails.
#[test]
fn a_racing_reader_never_sees_a_partial_document() {
    let temp = tempfile::tempdir().expect("a temp dir");
    let paths = SettingsPaths::from_config_dir(&repo_root(), temp.path().join("config"));
    let path = status::path(&paths);
    let large = document_with_workers(5_000);
    let small = document_with_workers(0);

    status::write(&path, &large).expect("the first document");

    let writer = {
        let path = path.clone();
        let large = large.clone();
        let small = small.clone();
        std::thread::spawn(move || {
            for index in 0..400 {
                let document = if index % 2 == 0 { &small } else { &large };
                status::write(&path, document).expect("a write");
            }
        })
    };

    let mut reads = 0;
    while !writer.is_finished() {
        let published = status::read(&paths, NOW_MS)
            .unwrap_or_else(|error| panic!("a read failed during a concurrent write: {}", error.reason));
        assert!(
            published.document == large || published.document == small,
            "a read carried a whole document, not a partial one: {} workers",
            published.document.workers.len()
        );
        reads += 1;
    }
    writer.join().expect("the writer finishes");

    assert!(reads > 0, "the reader raced at least one write");
}
