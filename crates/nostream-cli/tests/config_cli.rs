//! End-to-end tests for the `config` subcommands.

// This integration-test target may unwrap: a failing assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::path::PathBuf;

use nostream_cli::commands::config;
use nostream_cli::config::resolve_paths;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../")
        .canonicalize()
        .expect("the workspace root exists")
}

#[test]
fn config_get_prints_the_relay_url() {
    let output = config::get(&workspace_root(), None, "info.relay_url", false).expect("get");
    assert_eq!(output.lines, ["wss://nostream.your-domain.com"]);
    assert_eq!(output.exit_code, 0);
}

#[test]
fn config_get_json_round_trips() {
    let output = config::get(&workspace_root(), None, "info.pubkey", true).expect("get");
    assert_eq!(output.lines, ["\"replace-with-your-pubkey-in-hex\""]);
}

#[test]
fn config_validate_reports_the_clean_document() {
    let output = config::validate(&workspace_root(), None, None).expect("validate");
    assert_eq!(output.lines, ["settings valid: 0 issues"]);
    assert_eq!(output.exit_code, 0);
}

#[test]
fn config_validate_reports_issues_from_the_config_file() {
    let directory = tempfile::tempdir().expect("tempdir");
    fs::write(
        directory.path().join("settings.yaml"),
        "limits:\n  rateLimiter:\n    strategy: random\n",
    )
    .expect("write");
    let output =
        config::validate(&workspace_root(), Some(directory.path()), None).expect("validate");
    assert_eq!(output.exit_code, 2);
    assert!(output.lines[0].starts_with("limits.rateLimiter.strategy: "));
    assert_eq!(
        output.lines.last().map(String::as_str),
        Some("settings invalid: 1 issues")
    );
}

#[test]
fn the_paths_resolver_honours_the_config_dir() {
    let directory = tempfile::tempdir().expect("tempdir");
    let paths = resolve_paths(&workspace_root(), Some(directory.path()));
    assert_eq!(
        paths.default_settings_file,
        workspace_root().join("resources/default-settings.yaml")
    );
    assert_eq!(paths.config_base_dir, directory.path().to_path_buf());
}
