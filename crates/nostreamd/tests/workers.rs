//! The Tor bootstrap is a one-shot task the drain can abandon (R7, ADR 0004).
//!
//! `serve` joins the Tor task after the drain, and the control-port read has no timeout of its
//! own, so a control port that accepts and never answers must not hold the process open past
//! SIGINT.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../")
        .canonicalize()
        .expect("the workspace root exists")
}

/// Runs the daemon for two seconds, sends SIGINT, and returns its exit code and streams.
// shortcut: a fixed settle instead of reading the bound port back from the log; upgrade when
// daemon startup grows a step slower than the settle.
fn run_daemon(config_dir: &Path, control_port: u16) -> (Option<i32>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_nostreamd"))
        .args([
            "--config-dir",
            config_dir.to_str().expect("utf-8"),
            "--listen-port",
            "0",
            "--log-level",
            "info",
        ])
        .env("TOR_HOST", "127.0.0.1")
        .env("TOR_CONTROL_PORT", control_port.to_string())
        .current_dir(workspace_root())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary spawns");

    std::thread::sleep(Duration::from_secs(2));

    if child.try_wait().expect("wait works").is_none() {
        let status = Command::new("kill")
            .args(["-INT", &child.id().to_string()])
            .status()
            .expect("kill runs");
        assert!(status.success(), "SIGINT was delivered");
    }

    let deadline = Instant::now() + Duration::from_secs(20);

    loop {
        match child.try_wait().expect("wait works") {
            Some(_) => break,
            None if Instant::now() > deadline => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("the daemon did not drain after SIGINT");
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }

    let output = child.wait_with_output().expect("the pipes are readable");
    let logs = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    (output.status.code(), logs)
}

#[test]
fn a_silent_control_port_does_not_hold_the_daemon_open_past_the_drain() {
    // Accept the connection and answer nothing: `TorClient::connect` waits in its read.
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind the control port");
    let control_port = listener.local_addr().expect("local addr").port();
    let _silent_port = std::thread::spawn(move || {
        if let Ok((stream, _)) = listener.accept() {
            std::thread::sleep(Duration::from_secs(60));
            drop(stream);
        }
    });

    let directory = tempfile::tempdir().expect("tempdir");
    let (code, logs) = run_daemon(directory.path(), control_port);

    assert_eq!(code, Some(0), "the daemon drained: {logs}");
    assert!(
        logs.contains("Tor hidden service: disabled"),
        "the abandoned bootstrap reports the disabled line: {logs}"
    );
}
