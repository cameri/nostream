//! `--check` validates the settings and exits; it never installs telemetry, binds a port or
//! waits for a signal. Regression test for round 3's P0: the gate alone passed while `run()`
//! fell through into `serve`.

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
