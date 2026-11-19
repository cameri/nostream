//! AC24's file, rewritten for cost: one append is one `write`, and the 2,000-entry cap is kept
//! by a compaction that runs once per `AUDIT_COMPACT_EVERY` appends (`state.rs`, D9).
//!
//! | case | what it proves |
//! |---|---|
//! | `a_logout_appends_exactly_one_line` | the unauthenticated `POST /logout` that reaches the append writes one line |
//! | `the_cap_survives_two_thousand_appends` | a file at the cap stays at the cap, with the newest entries kept |

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::TestServer;

fn audit_path(server: &TestServer) -> std::path::PathBuf {
    server.config_dir.join("admin-audit.jsonl")
}

fn line_count(path: &std::path::Path) -> usize {
    std::fs::read_to_string(path)
        .map(|raw| raw.lines().filter(|line| !line.trim().is_empty()).count())
        .unwrap_or(0)
}

#[tokio::test]
async fn a_logout_appends_exactly_one_line() {
    let server = TestServer::start().await;
    let path = audit_path(&server);

    let response = server.request("POST", "/admin/logout", &[], None).await;
    assert_eq!(response.status, 200, "logout answers 200 without a session");
    assert_eq!(line_count(&path), 1, "one append, one line");

    let entry: serde_json::Value = serde_json::from_str(
        std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(entry["action"], "admin.logout");
}

#[tokio::test]
async fn the_cap_survives_two_thousand_appends() {
    let server = TestServer::start().await;
    let path = audit_path(&server);

    // A file already at the cap, as a long-running daemon leaves it.
    let seeded: String = (0..nostream_admin::state::MAX_AUDIT_ENTRIES)
        .map(|index| {
            format!(
                "{{\"id\":\"seed-{index}\",\"at\":\"2026-11-19T00:00:00Z\",\"action\":\"seed\"}}\n"
            )
        })
        .collect();
    std::fs::write(&path, seeded).unwrap();
    assert_eq!(line_count(&path), nostream_admin::state::MAX_AUDIT_ENTRIES);

    for index in 0..nostream_admin::state::AUDIT_COMPACT_EVERY {
        server
            .state
            .append_audit(
                "admin.test",
                None,
                Some(serde_json::json!({ "index": index })),
            )
            .unwrap();
    }

    assert_eq!(
        line_count(&path),
        nostream_admin::state::MAX_AUDIT_ENTRIES,
        "the compaction kept the cap"
    );
    let last = std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .last()
        .unwrap()
        .to_owned();
    let last: serde_json::Value = serde_json::from_str(&last).unwrap();
    assert_eq!(last["action"], "admin.test", "the newest entry is kept");
}
