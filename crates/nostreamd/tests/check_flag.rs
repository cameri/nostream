//! `--check` validates the settings and exits; it never installs telemetry, binds a port or
//! waits for a signal. Regression test for round 3's P0: the gate alone passed while `run()`
//! fell through into `serve`.

// This integration-test target may unwrap and panic: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../")
        .canonicalize()
        .expect("the workspace root exists")
}

/// Runs `nostreamd --check …` with a hard deadline: `Command::output` blocks until the
/// child exits, so a reintroduced fall-through would park the suite until CI's timeout
/// instead of failing here. On expiry the child is killed and the assertion fires.
fn run_check(deadline: Duration, args: &[&str]) -> (Option<i32>, String, String) {
    let start = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_nostreamd"))
        .args(args)
        .current_dir(workspace_root())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary spawns");

    loop {
        match child.try_wait().expect("wait works") {
            Some(status) => {
                assert!(
                    start.elapsed() < deadline,
                    "--check must not block; it took {:?}",
                    start.elapsed()
                );
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    use std::io::Read;
                    let _ = pipe.read_to_string(&mut stdout);
                }
                if let Some(mut pipe) = child.stderr.take() {
                    use std::io::Read;
                    let _ = pipe.read_to_string(&mut stderr);
                }
                return (status.code(), stdout, stderr);
            }
            None => {
                if start.elapsed() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!(
                        "--check must not block; it was still running after {deadline:?} and was killed"
                    );
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

#[test]
fn check_exits_zero_on_a_valid_config_without_serving() {
    let (code, stdout, _stderr) = run_check(Duration::from_secs(30), &["--check"]);
    assert_eq!(code, Some(0), "exit code");
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

    let config_dir = directory.path().to_string_lossy().into_owned();
    let (code, _stdout, stderr) = run_check(
        Duration::from_secs(30),
        &["--check", "--config-dir", &config_dir],
    );
    assert_eq!(code, Some(2), "exit code");
    assert!(stderr.contains("strategy must be ewma or sliding_window"));
}

#[test]
fn check_exits_two_on_a_value_the_typed_schema_cannot_hold() {
    // `config validate` and the daemon must agree: a fractional integer is a positive number
    // to the document walk and unrepresentable to the typed schema, so it is refused with the
    // field named instead of being approved here and discarded at load.
    let directory = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        directory.path().join("settings.yaml"),
        "limits:\n  event:\n    pow:\n      periodMs: 1000.5\n",
    )
    .expect("write");

    let config_dir = directory.path().to_string_lossy().into_owned();
    let (code, _stdout, stderr) = run_check(
        Duration::from_secs(30),
        &["--check", "--config-dir", &config_dir],
    );
    assert_eq!(code, Some(2), "exit code");
    assert!(
        stderr.contains("limits.event.pow.periodMs"),
        "stderr: {stderr}"
    );
}

#[test]
fn check_refuses_a_settings_yaml_that_is_a_directory() {
    // A path that exists but is not a regular file used to read as absence, so `--check`
    // approved the defaults while the operator's real file was unusable.
    let directory = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir(directory.path().join("settings.yaml")).expect("a directory at the path");

    let config_dir = directory.path().to_string_lossy().into_owned();
    let (code, _stdout, stderr) = run_check(
        Duration::from_secs(30),
        &["--check", "--config-dir", &config_dir],
    );
    assert_ne!(code, Some(0), "a directory must not read as a clean config");
    assert!(stderr.contains("not a regular file"), "stderr: {stderr}");
}

#[test]
fn check_accepts_an_operator_file_that_sets_both_bounds() {
    // The two bounds #959 added are settings an operator writes, so the document has to carry
    // their keys: a value the validator does not know is refused as `Unknown setting key`, and
    // the daemon would keep running on the compiled defaults without saying so.
    let directory = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        directory.path().join("settings.yaml"),
        "network:\n  frameMemoryBudgetBytes: 134217728\nlimits:\n  connection:\n    maxConnectionsPerIp: 128\n",
    )
    .expect("write");

    let config_dir = directory.path().to_string_lossy().into_owned();
    let (code, stdout, stderr) = run_check(
        Duration::from_secs(30),
        &["--check", "--config-dir", &config_dir],
    );
    assert_eq!(code, Some(0), "exit code; stderr: {stderr}");
    assert_eq!(stdout.trim(), "settings valid: 0 issues");
}

#[test]
fn check_accepts_both_bounds_at_their_ceilings() {
    // The ceilings are the largest values the validator accepts, so the document is the
    // operator's and the relay runs with both numbers as written: one `settings valid` line,
    // nothing on stderr (#998, ADR 0009).
    let directory = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        directory.path().join("settings.yaml"),
        "network:\n  frameMemoryBudgetBytes: 1099511627776\nlimits:\n  connection:\n    maxConnectionsPerIp: 131072\n",
    )
    .expect("write");

    let config_dir = directory.path().to_string_lossy().into_owned();
    let (code, stdout, stderr) = run_check(
        Duration::from_secs(30),
        &["--check", "--config-dir", &config_dir],
    );
    assert_eq!(code, Some(0), "exit code; stderr: {stderr}");
    assert_eq!(stdout.trim(), "settings valid: 0 issues");
    assert_eq!(stderr, "");
}

#[test]
fn check_refuses_bounds_above_their_ceilings() {
    // A value above its ceiling is the operator's literal and the key is a valid key, but the
    // validator refuses it like a zero: `load` discards the whole document, so the verdict, the
    // exit code and the door all say so, and each line names the value the file states beside
    // the ceiling it crossed (#998, ADR 0009).
    let directory = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        directory.path().join("settings.yaml"),
        "network:\n  frameMemoryBudgetBytes: 1099511627777\nlimits:\n  connection:\n    maxConnectionsPerIp: 131073\n",
    )
    .expect("write");

    let config_dir = directory.path().to_string_lossy().into_owned();
    let (code, stdout, stderr) = run_check(
        Duration::from_secs(30),
        &["--check", "--config-dir", &config_dir],
    );
    assert_eq!(code, Some(2), "exit code; stderr: {stderr}");
    assert!(!stdout.contains("settings valid"), "stdout: {stdout}");
    // Whole lines, not prefixes: the key, the stated value and the ceiling all have to be there.
    assert!(
        stderr.contains(
            "network.frameMemoryBudgetBytes: the file states 1099511627777; frameMemoryBudgetBytes must be at most 1099511627776"
        ),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains(
            "limits.connection.maxConnectionsPerIp: the file states 131073; maxConnectionsPerIp must be at most 131072"
        ),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains("settings invalid: 2 issues"),
        "stderr: {stderr}"
    );
    assert!(
        !stderr.contains("above the"),
        "the ceiling is an issue, not a report: {stderr}"
    );
}

#[test]
fn check_refuses_a_zero_bound() {
    // A zero is a literal the operator wrote, so it is an issue like any other and `--check`
    // exits 2 on it. The daemon then continues on the shipped defaults, not on the zero (#996,
    // ADR 0008).
    let directory = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        directory.path().join("settings.yaml"),
        "network:\n  frameMemoryBudgetBytes: 0\nlimits:\n  connection:\n    maxConnectionsPerIp: 0\n",
    )
    .expect("write");

    let config_dir = directory.path().to_string_lossy().into_owned();
    let (code, stdout, stderr) = run_check(
        Duration::from_secs(30),
        &["--check", "--config-dir", &config_dir],
    );
    assert_eq!(code, Some(2), "exit code; stderr: {stderr}");
    assert!(!stdout.contains("settings valid"), "stdout: {stdout}");
    // Whole lines, not prefixes: the key and its sentence both have to be there.
    assert!(
        stderr.contains(
            "network.frameMemoryBudgetBytes: frameMemoryBudgetBytes must be greater than 0"
        ),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains(
            "limits.connection.maxConnectionsPerIp: maxConnectionsPerIp must be greater than 0"
        ),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains("settings invalid: 2 issues"),
        "stderr: {stderr}"
    );
    assert!(
        !stderr.contains("means the default"),
        "a zero is not a documented default any more: {stderr}"
    );
}

#[test]
fn check_reports_a_ceiling_and_a_schema_fault_together() {
    // A rejected document is still the operator's document: the issue list is what `load`
    // collected before it substituted the shipped defaults, so the schema fault and the ceiling
    // both reach the door, in that order, and the exit code is the shared invalid verdict
    // (#998, ADR 0009).
    let directory = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        directory.path().join("settings.yaml"),
        "network:\n  frameMemoryBudgetBytes: 1099511627777\nlimits:\n  rateLimiter:\n    strategy: random\n",
    )
    .expect("write");

    let config_dir = directory.path().to_string_lossy().into_owned();
    let (code, stdout, stderr) = run_check(
        Duration::from_secs(30),
        &["--check", "--config-dir", &config_dir],
    );
    assert_eq!(code, Some(2), "exit code");
    assert!(!stdout.contains("settings valid"), "stdout: {stdout}");
    assert!(
        stderr.contains("strategy must be ewma or sliding_window"),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains(
            "network.frameMemoryBudgetBytes: the file states 1099511627777; frameMemoryBudgetBytes must be at most 1099511627776"
        ),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains("settings invalid: 2 issues"),
        "stderr: {stderr}"
    );
}

#[test]
fn check_reports_nothing_for_the_shipped_defaults() {
    // With no user document, `settings` is the shipped defaults with `used_defaults` false, so a
    // report that walked them would describe the document's own values as violations on a fresh
    // install. The guard is what prevents it; without the guard this test sees two lines.
    let directory = tempfile::tempdir().expect("tempdir");

    let config_dir = directory.path().to_string_lossy().into_owned();
    let (code, stdout, stderr) = run_check(
        Duration::from_secs(30),
        &["--check", "--config-dir", &config_dir],
    );
    assert_eq!(code, Some(0), "exit code");
    assert_eq!(stdout.trim(), "settings valid: 0 issues");
    assert_eq!(stderr, "", "the shipped defaults are not a violation");
}
