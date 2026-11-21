//! The CLI surface a Windows job can reach: the page, the version, the unknown word and the
//! single `--help` route, none of which needs a shell, a store or a daemon.
//!
//! The Unix-only half — the PATH shims, the compose argv, the store fixtures — is
//! `cli_surface.rs`, which this target's `#![cfg(not(unix))]` keeps out of the Windows build. The
//! pair is the same one the migration targets use (`migrate_cli.rs` / `migrate_cli_unsupported.rs`).
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![cfg(not(unix))]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::process::{Command, Output};

fn cli(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(args)
        .output()
        .expect("the binary runs")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn code(output: &Output) -> i32 {
    output.status.code().expect("the child exited")
}

#[test]
fn the_page_is_the_captures_on_stdout() {
    let output = cli(&["--help"]);

    assert_eq!(code(&output), 0, "{}", stderr(&output));
    let page = stdout(&output);
    assert!(page.contains("Usage:"), "{page}");
    assert!(page.contains("start [...args]"), "{page}");
    assert!(page.contains("-v, --version"), "{page}");
    assert!(!page.lines().any(|line| line.contains("dev")), "{page}");
}

#[test]
fn no_arguments_prints_the_same_page() {
    let output = cli(&[]);

    assert_eq!(code(&output), 0);
    assert!(stderr(&output).is_empty(), "{}", stderr(&output));
    assert_eq!(stdout(&output), stdout(&cli(&["--help"])));
}

#[test]
fn the_version_page_is_the_crates_own() {
    let output = cli(&["--version"]);

    assert_eq!(code(&output), 0);
    assert_eq!(
        stdout(&output),
        format!("nostream/{}\n", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn an_unknown_word_marks_stderr_and_pages_stdout() {
    let output = cli(&["wobble"]);

    assert_eq!(code(&output), 2);
    assert_eq!(stderr(&output), "Unknown command: wobble\n");
    assert!(stdout(&output).contains("Usage:"));
}

#[test]
fn the_help_subcommand_stays_absent() {
    let output = cli(&["help", "import"]);

    assert_eq!(code(&output), 2);
    assert_eq!(stderr(&output), "Unknown command: help\n");
}
