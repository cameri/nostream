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
fn check_reports_a_bound_it_would_replace_with_the_default() {
    // The key and the number are both valid, so this is not an issue and not fatal — but a value
    // discarded at start-up used to be silent, and `--check` is where an operator looks first.
    let directory = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        directory.path().join("settings.yaml"),
        "network:\n  frameMemoryBudgetBytes: 1099511627777\nlimits:\n  connection:\n    maxConnectionsPerIp: 1099511627777\n",
    )
    .expect("write");

    let config_dir = directory.path().to_string_lossy().into_owned();
    let (code, stdout, stderr) = run_check(
        Duration::from_secs(30),
        &["--check", "--config-dir", &config_dir],
    );
    assert_eq!(code, Some(0), "exit code");
    assert_eq!(stdout.trim(), "settings valid: 0 issues");
    assert!(
        stderr.contains("network.frameMemoryBudgetBytes: above the 1099511627776 a bound accepts"),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains(
            "limits.connection.maxConnectionsPerIp: above the 1099511627776 a bound accepts"
        ),
        "stderr: {stderr}"
    );
}

#[test]
fn check_reports_a_zero_bound_as_the_documented_default() {
    // Zero is not "out of range": both the defaults document and `--check` document it as the
    // default, so the line must not call it a violation.
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
    assert_eq!(code, Some(0), "exit code");
    assert_eq!(stdout.trim(), "settings valid: 0 issues");
    assert!(
        stderr.contains("network.frameMemoryBudgetBytes: 0 means the default"),
        "stderr: {stderr}"
    );
    assert!(
        !stderr.contains("above the"),
        "a zero must not be reported as above the ceiling: {stderr}"
    );
}

#[test]
fn check_reports_the_schema_fault_and_not_a_bound_it_cannot_read() {
    // On a rejected document `load` substitutes the shipped defaults, so there is no operator
    // number left to describe: the gate is unconditional but has nothing to walk. This pins that
    // it does not invent a range line, and that the exit code stays the schema verdict (2).
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
    assert!(!stderr.contains("above the"), "no range line: {stderr}");
}
