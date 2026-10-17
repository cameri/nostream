//! `--check` validates the settings and exits; it never installs telemetry, binds a port or
//! waits for a signal. Regression test for round 3's P0: the gate alone passed while `run()`
//! fell through into `serve`.

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../")
        .canonicalize()
        .expect("the workspace root exists")
}

#[test]
fn check_exits_zero_on_a_valid_config_without_serving() {
    let start = Instant::now();
    let output = Command::new(env!("CARGO_BIN_EXE_nostreamd"))
        .arg("--check")
        .current_dir(workspace_root())
        .output()
        .expect("the binary spawns");

    assert!(
        start.elapsed() < Duration::from_secs(60),
        "--check must not block; it took {:?}",
        start.elapsed()
    );
    assert!(output.status.success(), "exit {:?}", output.status.code());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "settings valid: 0 issues");
}

#[test]
fn check_exits_two_on_an_invalid_config() {
    let directory = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        directory.path().join("settings.yaml"),
        "limits:\n  rateLimiter:\n    strategy: random\n",
    )
    .expect("write");

    let output = Command::new(env!("CARGO_BIN_EXE_nostreamd"))
        .arg("--check")
        .arg("--config-dir")
        .arg(directory.path())
        .current_dir(workspace_root())
        .output()
        .expect("the binary spawns");
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("strategy must be ewma or sliding_window"));
}
