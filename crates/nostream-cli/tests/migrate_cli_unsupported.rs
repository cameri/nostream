//! The `migrate pg-to-lmdb` command where the copy cannot run: every part of it needs Unix file
//! modes, so the command still exists but refuses, and this file pins what it answers.
//!
//! The copy, the manifest, resume and verify live in `migrate_cli.rs`, which compiles only on
//! Unix. CI runs this one from the `windows-latest` job.

#![cfg(not(unix))]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::process::Command;

/// The refusal names the command, says the platform is the reason, and exits non-zero, so an
/// operator reading a pipeline log learns why rather than seeing a compile error or a hang.
#[test]
fn the_command_is_refused_with_a_named_reason_and_exit_1() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["migrate", "pg-to-lmdb", "--target"])
        .arg(directory.path())
        .output()
        .expect("the binary runs");

    assert_eq!(output.status.code(), Some(1), "the refusal exits 1");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("migrate pg-to-lmdb is unsupported on this platform"),
        "the refusal names the command and the reason: {stdout}"
    );
}
