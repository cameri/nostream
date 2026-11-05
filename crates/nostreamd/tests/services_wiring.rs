//! The daemon supplies the real trust graph (R35, AC44).
//!
//! With the shipped `wot.enabled: false` nothing changes; with it on and no backend wired the
//! graph fails to build, logs once and answers `None` — the same answer `UnavailableWotGraph`
//! gives — while the daemon keeps serving.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use nostream_config::settings::{Nip56Settings, Settings, WotSettings};
use nostream_core::clock::TestClock;
use nostream_core::{Event, EventId, Kind, Pubkey, SettingsPubkey, Signature};
use nostream_relay::relay_key::RelayKeySource;
use nostream_relay::strategies::EventStrategy;
use nostream_relay::strategies::report::ReportStrategy;
use nostream_relay::testing::Fixture;
use nostream_relay::unavailable::UnavailableWotGraph;
use nostream_services::services::wot_graph_service::WotGraphService;

#[derive(Clone, Default)]
struct Buffer(Arc<std::sync::Mutex<Vec<u8>>>);

impl Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .extend_from_slice(bytes);

        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Buffer {
    type Writer = Buffer;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn captured(buffer: &Buffer) -> String {
    String::from_utf8(
        buffer
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone(),
    )
    .unwrap_or_default()
}

fn settings_with_the_graph_enabled() -> Settings {
    let mut settings = nostream_relay::testing::settings();
    settings.wot = Some(WotSettings {
        enabled: true,
        seed_pubkey: SettingsPubkey("01".repeat(32)),
        minimum_followers: 1,
        max_depth: 2,
        refresh_interval_hours: 24,
    });
    settings.nip56 = Some(Nip56Settings {
        enabled: true,
        trusted_moderators: Vec::new(),
        hide_actionable_reports: false,
    });

    settings
}

/// A NIP-56 report by a pubkey the graph has never seen.
fn report_event() -> Event {
    Event {
        id: EventId::from_byte_array([0x11; 32]),
        pubkey: Pubkey::from_byte_array([0x22; 32]),
        created_at: 1_700_000_000,
        kind: Kind(1_984),
        tags: vec![vec!["p".to_owned(), "33".repeat(32)]],
        content: "spam".to_owned(),
        sig: Signature::from_byte_array([0; 64]),
    }
}

#[tokio::test]
async fn a_wot_report_lookup_answers_like_the_unavailable_graph_and_logs_one_rebuild_error() {
    let buffer = Buffer::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(buffer.clone())
        .with_max_level(tracing::Level::ERROR)
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let settings = Arc::new(settings_with_the_graph_enabled());
    let event = report_event();

    // The daemon's wiring: the real service over the unavailable backend.
    let fixture = Fixture::new((*settings).clone());
    let mut context = fixture.anonymous_context(
        Arc::new(TestClock::new(1_700_000_000_000)),
        RelayKeySource::from_values(None, None),
    );
    context.wot = Arc::new(WotGraphService::new(
        Arc::clone(&settings),
        nostream_services::unavailable::stores().events,
    ));

    ReportStrategy
        .execute(&event, &context)
        .await
        .expect("report");

    // The comparison: the graph the daemon used to be handed.
    let fallback = Fixture::new((*settings).clone());
    let mut fallback_context = fallback.anonymous_context(
        Arc::new(TestClock::new(1_700_000_000_000)),
        RelayKeySource::from_values(None, None),
    );
    fallback_context.wot = Arc::new(UnavailableWotGraph);

    ReportStrategy
        .execute(&event, &fallback_context)
        .await
        .expect("report");

    let with_service = fixture.reports.reports();
    let with_fallback = fallback.reports.reports();
    assert_eq!(with_service.len(), 1, "the report is still stored");
    assert_eq!(with_fallback.len(), 1);
    assert_eq!(
        with_service[0].weight, with_fallback[0].weight,
        "a failed rebuild answers exactly as the disabled graph does"
    );

    let logs = captured(&buffer);
    assert_eq!(
        logs.matches("wot graph rebuild failed").count(),
        1,
        "one rebuild error is logged: {logs}"
    );
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../")
        .canonicalize()
        .expect("the workspace root exists")
}

/// Runs the daemon for two seconds, sends SIGINT, and returns its exit code and streams.
// shortcut: a fixed settle instead of reading the bound port back from the log; upgrade when
// daemon startup grows a step slower than the settle.
fn run_daemon(config_dir: &Path) -> (Option<i32>, String, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_nostreamd"))
        .args([
            "--config-dir",
            config_dir.to_str().expect("utf-8"),
            "--listen-port",
            "0",
            "--log-level",
            "info",
        ])
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

    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn the_daemon_serves_with_the_wot_graph_enabled() {
    let directory = tempfile::tempdir().expect("tempdir");
    fs::write(
        directory.path().join("settings.yaml"),
        "wot:\n  enabled: true\n  seedPubkey: \"0101010101010101010101010101010101010101010101010101010101010101\"\n",
    )
    .expect("write");

    let (code, stdout, stderr) = run_daemon(directory.path());
    let logs = format!("{stdout}{stderr}");

    assert_eq!(code, Some(0), "exit code; logs: {logs}");
    assert!(
        logs.contains("the acceptor is listening"),
        "the daemon served: {logs}"
    );
    assert!(
        logs.contains("signal received; draining") && logs.contains("drained; exiting"),
        "the daemon drained: {logs}"
    );
    assert!(
        !logs.contains("background task ended with an error"),
        "no background task failed: {logs}"
    );
    assert!(
        !logs.contains("nostreamd::workers::spawn_workers")
            && !logs.contains("nostreamd::workers::spawn_tor"),
        "the worker hooks are no longer stubs: {logs}"
    );
}
