//! The worker model: the runtime thread count, respawn, the drain deadline and registration.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use nostream_config::settings::{Dvm, DvmWorker};
use nostream_core::lifecycle::ShutdownState;
use nostream_core::random::SystemRandom;
use nostream_relay::relay_key::RelayKeySource;
use nostream_services::ServiceContext;
use nostream_services::error::ServicesError;
use nostream_services::scheduler::{
    Supervisor, WorkerSpec, resolve_worker_count, supervisor_drain_deadline,
};
use nostream_services::testing;
use tokio::sync::broadcast;

fn context(settings: nostream_config::Settings) -> ServiceContext {
    let (hub, _receiver) = broadcast::channel(16);
    let client = testing::RecordingHttpClient::new();
    let http: Arc<dyn nostream_services::HttpClient> = client;

    ServiceContext {
        settings: Arc::new(settings),
        clock: testing::clock(1_700_000_000_000),
        random: Arc::new(SystemRandom),
        keys: Arc::new(RelayKeySource::from_values(None, None)),
        stores: Arc::new(nostream_services::unavailable::stores()),
        hub,
        http,
        fetch: testing::FakeNip05Fetch::new(),
        config_dir: std::path::PathBuf::from("/tmp"),
    }
}

#[test]
fn worker_count_follows_the_environment_then_the_settings_then_the_cpus() {
    let cpus = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1);

    assert_eq!(resolve_worker_count(Some("2"), 0), 2);
    assert_eq!(resolve_worker_count(None, 2), 2);
    assert_eq!(resolve_worker_count(None, 0), cpus);
    assert_eq!(resolve_worker_count(Some("abc"), 0), cpus);
    assert_eq!(resolve_worker_count(Some("0"), 0), cpus);
    assert_eq!(resolve_worker_count(Some("-1"), 0), cpus);
    assert_eq!(resolve_worker_count(Some("abc"), 2), 2);
}

#[tokio::test]
async fn a_failed_worker_is_restarted_and_a_clean_one_is_not() {
    let shutdown = ShutdownState::new();
    let runs = Arc::new(AtomicUsize::new(0));
    let clean_runs = Arc::new(AtomicUsize::new(0));

    let failing_runs = Arc::clone(&runs);
    let clean_for_loop = Arc::clone(&clean_runs);

    let mut supervisor = Supervisor::new(shutdown.clone())
        .with_restart_delay(Duration::from_millis(20))
        .with_drain_deadline(Duration::from_secs(2));

    supervisor.register(WorkerSpec::new(
        "failing",
        Box::new(move |_shutdown| {
            let runs = Arc::clone(&failing_runs);
            Box::pin(async move {
                let attempt = runs.fetch_add(1, Ordering::SeqCst) + 1;

                if attempt < 3 {
                    Err(ServicesError::Configuration("synthetic failure".to_owned()))
                } else {
                    Ok(())
                }
            })
        }),
    ));
    supervisor.register(WorkerSpec::new(
        "clean",
        Box::new(move |_shutdown| {
            let runs = Arc::clone(&clean_for_loop);
            Box::pin(async move {
                runs.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }),
    ));

    let task = tokio::spawn(supervisor.run());

    let deadline = Instant::now() + Duration::from_secs(3);
    while runs.load(Ordering::SeqCst) < 3 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    assert!(
        runs.load(Ordering::SeqCst) >= 2,
        "the failing worker ran again, got {}",
        runs.load(Ordering::SeqCst)
    );

    tokio::time::sleep(Duration::from_millis(50)).await;
    shutdown.begin_draining();

    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("the supervisor stops")
        .expect("join")
        .expect("the supervisor returns Ok");

    assert_eq!(
        clean_runs.load(Ordering::SeqCst),
        1,
        "a worker that returned Ok is not restarted"
    );
}

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

#[tokio::test]
async fn the_drain_deadline_aborts_a_worker_that_ignores_it() {
    let buffer = Buffer::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(buffer.clone())
        .with_max_level(tracing::Level::WARN)
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let shutdown = ShutdownState::new();
    let mut supervisor = Supervisor::new(shutdown.clone())
        .with_restart_delay(Duration::from_millis(10))
        .with_drain_deadline(Duration::from_millis(150));

    supervisor.register(WorkerSpec::new(
        "stubborn",
        Box::new(move |_shutdown| {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(())
            })
        }),
    ));

    let task = tokio::spawn(supervisor.run());
    tokio::time::sleep(Duration::from_millis(30)).await;

    let started = Instant::now();
    shutdown.begin_draining();

    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("the deadline ends the supervisor")
        .expect("join")
        .expect("the supervisor returns Ok");

    assert!(
        started.elapsed() >= Duration::from_millis(100),
        "the supervisor waited for the deadline, took {:?}",
        started.elapsed()
    );

    let logs = String::from_utf8(
        buffer
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone(),
    )
    .unwrap_or_default();

    assert!(
        logs.contains("terminating workers after the drain deadline"),
        "the deadline warning is logged, got: {logs}"
    );
}

#[tokio::test]
async fn a_cooperating_worker_returns_before_the_deadline() {
    let shutdown = ShutdownState::new();
    let mut supervisor =
        Supervisor::new(shutdown.clone()).with_drain_deadline(Duration::from_secs(5));

    supervisor.register(WorkerSpec::new(
        "cooperative",
        Box::new(move |shutdown| {
            Box::pin(async move {
                shutdown.wait_for_drain().await;
                Ok(())
            })
        }),
    ));

    let task = tokio::spawn(supervisor.run());
    tokio::time::sleep(Duration::from_millis(20)).await;

    let started = Instant::now();
    shutdown.begin_draining();

    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .expect("the supervisor returns as soon as the last worker ends")
        .expect("join")
        .expect("the supervisor returns Ok");

    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn the_drain_deadline_is_the_websocket_timeout_plus_five_seconds() {
    assert_eq!(
        supervisor_drain_deadline(None),
        Duration::from_millis(35_000)
    );
    assert_eq!(
        supervisor_drain_deadline(Some("0")),
        Duration::from_millis(5_000)
    );
    assert_eq!(
        supervisor_drain_deadline(Some("1000")),
        Duration::from_millis(6_000)
    );
}

#[test]
fn dvm_workers_register_one_spec_each() {
    let mut settings = testing::settings();

    settings.dvm = Some(Dvm {
        workers: Some(Vec::new()),
    });
    assert_eq!(
        nostream_services::workers::dvm_orchestrator::dvm_specs(&context(settings.clone()))
            .expect("specs")
            .len(),
        0
    );

    settings.dvm = None;
    assert_eq!(
        nostream_services::workers::dvm_orchestrator::dvm_specs(&context(settings.clone()))
            .expect("specs")
            .len(),
        0
    );

    settings.dvm = Some(Dvm {
        workers: Some(vec![
            DvmWorker {
                command: "/bin/sh".to_owned(),
                args: Some(vec!["-c".to_owned(), "cat".to_owned()]),
                kinds: None,
                timeout_ms: None,
            },
            DvmWorker {
                command: "/bin/sh".to_owned(),
                args: Some(vec!["-c".to_owned(), "cat".to_owned()]),
                kinds: Some(vec![5000]),
                timeout_ms: Some(1_000),
            },
        ]),
    });
    assert_eq!(
        nostream_services::workers::dvm_orchestrator::dvm_specs(&context(settings))
            .expect("specs")
            .len(),
        2
    );
}
