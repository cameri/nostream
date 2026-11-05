//! The DVM orchestrator: a child process, the job's status trail, the reply and the timeout.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use nostream_config::settings::{Dvm, DvmWorker};
use nostream_core::Kind;
use nostream_core::lifecycle::ShutdownState;
use nostream_relay::relay_key::RelayKeySource;
use nostream_services::testing;
use nostream_services::unavailable::ServiceStores;
use nostream_services::workers::dvm_orchestrator::{
    DEFAULT_JOB_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS, DISPATCH_BATCH_SIZE, DvmOrchestrator,
    DvmWorkerConfig, dvm_specs,
};
use nostream_storage::repositories::{DvmJob, DvmJobStatus, DvmJobUpdate, FieldUpdate};
use tokio::sync::broadcast;

const SECRET: [u8; 32] = [1; 32];

fn job_for(event: &nostream_core::Event) -> DvmJob {
    let now = chrono::Utc::now();

    DvmJob {
        id: event.id,
        requester_pubkey: event.pubkey,
        kind: event.kind,
        worker_index: None,
        status: DvmJobStatus::Submitted,
        result_event_id: None,
        error: None,
        picked_up_at: None,
        completed_at: None,
        created_at: now,
        updated_at: now,
    }
}

fn worker(args: Vec<&str>, timeout_ms: u64) -> DvmWorkerConfig {
    DvmWorkerConfig {
        index: 0,
        command: "sh".to_owned(),
        args: args.into_iter().map(str::to_owned).collect(),
        kinds: None,
        timeout: Duration::from_millis(timeout_ms),
    }
}

struct Fixture {
    orchestrator: Arc<DvmOrchestrator>,
    hub: broadcast::Sender<Arc<nostream_core::Event>>,
    events: Arc<testing::InMemoryEventRepository>,
    jobs: Arc<testing::InMemoryDvmJobRepository>,
    settings: Arc<nostream_config::Settings>,
}

fn build(config: DvmWorkerConfig, with_key: bool) -> Fixture {
    let request = testing::signed_event(&SECRET, Kind(5100), Vec::new(), "request");

    build_with(
        vec![request.clone()],
        vec![job_for(&request)],
        config,
        with_key,
    )
}

fn build_with(
    requests: Vec<nostream_core::Event>,
    seeded: Vec<DvmJob>,
    config: DvmWorkerConfig,
    with_key: bool,
) -> Fixture {
    let events = testing::InMemoryEventRepository::with_events(requests);
    let jobs = testing::InMemoryDvmJobRepository::new();
    jobs.set_jobs(seeded);
    let stores = Arc::new(ServiceStores {
        events: Arc::clone(&events) as Arc<dyn nostream_storage::repositories::EventRepository>,
        users: testing::InMemoryUserRepository::new(),
        invoices: testing::InMemoryInvoiceRepository::new(),
        nip05: testing::InMemoryNip05Repository::new(),
        dvm_jobs: Arc::clone(&jobs) as Arc<dyn nostream_storage::repositories::DvmJobRepository>,
        notification_outbox: testing::InMemoryOutboxRepository::new(),
        notification_delivery_log: testing::InMemoryDeliveryLogRepository::new(),
    });
    let (hub, _receiver) = broadcast::channel(16);
    let mut settings = testing::settings();
    settings.dvm = Some(Dvm {
        workers: Some(vec![DvmWorker {
            command: config.command.clone(),
            args: Some(config.args.clone()),
            kinds: None,
            timeout_ms: None,
        }]),
    });
    let settings = Arc::new(settings);
    let keys = if with_key {
        RelayKeySource::from_values(Some("01".repeat(32)), None)
    } else {
        RelayKeySource::from_values(None, None)
    };
    let orchestrator = Arc::new(DvmOrchestrator::new(
        Arc::clone(&settings),
        stores,
        Arc::new(keys),
        testing::clock(1_700_000_000_000),
        hub.clone(),
        config,
        Duration::from_millis(25),
    ));

    Fixture {
        orchestrator,
        hub,
        events,
        jobs,
        settings,
    }
}

async fn await_result(
    receiver: &mut broadcast::Receiver<Arc<nostream_core::Event>>,
    kind: Kind,
) -> Arc<nostream_core::Event> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = receiver.recv().await.expect("a live hub");
            if event.kind == kind {
                return event;
            }
        }
    })
    .await
    .expect("the result arrives")
}

#[tokio::test]
async fn a_job_is_dispatched_to_the_child_and_its_reply_is_published() {
    let fixture = build(worker(vec!["-c", "cat"], 5_000), true);
    let mut receiver = fixture.hub.subscribe();
    let shutdown = ShutdownState::new();
    let running = tokio::spawn(Arc::clone(&fixture.orchestrator).run(shutdown.clone()));

    let result = await_result(&mut receiver, Kind(6100)).await;

    assert_eq!(fixture.orchestrator.command(), "sh");
    assert_eq!(
        result.content, "request",
        "cat echoes the request's content"
    );
    assert_eq!(result.tags[0][0], "e");
    assert_eq!(result.tags[1][0], "p");
    let expected_pubkey = RelayKeySource::from_values(Some("01".repeat(32)), None)
        .resolve(&fixture.settings.info.relay_url)
        .expect("the relay key")
        .public_key;
    assert_eq!(result.pubkey, expected_pubkey);

    let updates = fixture.jobs.updates();
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].status, DvmJobStatus::Completed);
    assert!(matches!(
        updates[0].result_event_id,
        nostream_storage::repositories::FieldUpdate::Set(_)
    ));
    assert_eq!(
        fixture.jobs.assigned(),
        vec![(result.tags[0][1].parse().expect("the request id"), 0)]
    );
    assert_eq!(fixture.events.creates().len(), 1);
    assert_eq!(fixture.jobs.pending_calls()[0].0, DISPATCH_BATCH_SIZE);

    shutdown.begin_draining();
    let _ = tokio::time::timeout(Duration::from_secs(5), running).await;
}

#[tokio::test]
async fn a_job_that_outlives_its_timeout_is_timed_out_and_the_worker_killed() {
    let fixture = build(worker(vec!["-c", "sleep 60"], 50), true);
    let mut receiver = fixture.hub.subscribe();
    let shutdown = ShutdownState::new();
    let running = tokio::spawn(Arc::clone(&fixture.orchestrator).run(shutdown.clone()));

    let updates = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let updates = fixture.jobs.updates();
            if !updates.is_empty() {
                return updates;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the timeout fires");

    assert_eq!(updates[0].status, DvmJobStatus::TimedOut);
    assert_eq!(
        updates[0].error,
        nostream_storage::repositories::FieldUpdate::Set("worker timeout".to_owned())
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(200), receiver.recv())
            .await
            .is_err(),
        "a timed-out job publishes no result"
    );

    shutdown.begin_draining();
    let _ = tokio::time::timeout(Duration::from_secs(5), running).await;
}

#[tokio::test]
async fn a_result_that_cannot_be_signed_fails_the_job() {
    let fixture = build(worker(vec!["-c", "cat"], 5_000), false);
    let shutdown = ShutdownState::new();
    let running = tokio::spawn(Arc::clone(&fixture.orchestrator).run(shutdown.clone()));

    let updates = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let updates = fixture.jobs.updates();
            if !updates.is_empty() {
                return updates;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the failure is recorded");

    assert_eq!(updates[0].status, DvmJobStatus::Failed);
    match &updates[0].error {
        nostream_storage::repositories::FieldUpdate::Set(message) => {
            assert!(
                message.starts_with("unable to publish result:"),
                "{message}"
            );
        }
        other => panic!("expected an error, got {other:?}"),
    }

    shutdown.begin_draining();
    let _ = tokio::time::timeout(Duration::from_secs(5), running).await;
}

#[test]
fn one_spec_per_configured_worker_and_none_without_configuration() {
    let mut settings = testing::settings();
    settings.dvm = None;
    let context = nostream_services::testing::context(settings.clone());
    assert!(dvm_specs(&context).expect("no workers").is_empty());

    settings.dvm = Some(Dvm { workers: None });
    let context = nostream_services::testing::context(settings.clone());
    assert!(dvm_specs(&context).expect("no workers").is_empty());

    settings.dvm = Some(Dvm {
        workers: Some(vec![
            DvmWorker {
                command: "sh".to_owned(),
                args: Some(vec!["-c".to_owned(), "cat".to_owned()]),
                kinds: Some(vec![5100]),
                timeout_ms: Some(100),
            },
            DvmWorker {
                command: "sh".to_owned(),
                args: None,
                kinds: None,
                timeout_ms: None,
            },
        ]),
    });
    let context = nostream_services::testing::context(settings);
    assert_eq!(dvm_specs(&context).expect("two workers").len(), 2);
    assert_eq!(
        DvmWorkerConfig::from_settings(
            1,
            &DvmWorker {
                command: "sh".to_owned(),
                args: None,
                kinds: None,
                timeout_ms: None,
            }
        )
        .timeout,
        Duration::from_millis(60_000)
    );
}

/// Waits for `count` status updates, then returns them.
async fn await_updates(fixture: &Fixture, count: usize) -> Vec<DvmJobUpdate> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let updates = fixture.jobs.updates();
            if updates.len() >= count {
                return updates;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the updates arrive")
}

#[tokio::test]
async fn a_picked_up_job_does_not_starve_the_submitted_one_behind_it() {
    let request = testing::signed_event(&SECRET, Kind(5100), Vec::new(), "request");
    let mut picked_up = job_for(&request);
    picked_up.id = nostream_core::EventId::from_byte_array([9; 32]);
    picked_up.status = DvmJobStatus::PickedUp;
    let submitted = job_for(&request);

    let directory = tempfile::tempdir().expect("tempdir");
    let record = directory.path().join("request.json");
    let mut config = worker(
        vec![
            "-c",
            &format!(
                "while read line; do printf '%s\\n' \"$line\" >> '{}'; printf '%s\\n' \"$line\"; done",
                record.display()
            ),
        ],
        5_000,
    );
    config.kinds = Some(vec![Kind(5100)]);

    let fixture = build_with(
        vec![request.clone()],
        vec![picked_up, submitted.clone()],
        config,
        true,
    );
    let mut receiver = fixture.hub.subscribe();
    let shutdown = ShutdownState::new();
    let running = tokio::spawn(Arc::clone(&fixture.orchestrator).run(shutdown.clone()));

    let result = await_result(&mut receiver, Kind(6100)).await;
    assert_eq!(result.tags[0][1], submitted.id.to_string());
    assert_eq!(
        fixture.jobs.assigned(),
        vec![(submitted.id, 0)],
        "assign_worker skips the picked-up job at the head"
    );
    let updates = await_updates(&fixture, 1).await;
    assert_eq!(
        updates[0].id, submitted.id,
        "the submitted job is the one dispatched, not the picked-up one at the head"
    );
    assert_eq!(
        fixture.jobs.pending_calls()[0],
        (DISPATCH_BATCH_SIZE, Some(vec![Kind(5100)])),
        "the batch and the configured kinds reach the repository"
    );

    let sent: serde_json::Value = serde_json::from_str(
        std::fs::read_to_string(&record)
            .expect("the child recorded the line")
            .trim(),
    )
    .expect("the request is JSON");
    assert_eq!(sent["id"], serde_json::json!(request.id.to_string()));
    assert_eq!(sent["kind"], serde_json::json!(5100));
    assert_eq!(
        sent["pubkey"],
        serde_json::json!(request.pubkey.to_string())
    );
    assert_eq!(sent["tags"], serde_json::json!(request.tags));
    assert_eq!(sent["content"], serde_json::json!("request"));
    assert_eq!(
        sent.as_object().expect("an object").len(),
        5,
        "the request is exactly id, kind, pubkey, tags and content"
    );

    shutdown.begin_draining();
    let _ = tokio::time::timeout(Duration::from_secs(5), running).await;
}

#[tokio::test]
async fn a_missing_source_event_fails_the_job() {
    let request = testing::signed_event(&SECRET, Kind(5100), Vec::new(), "request");
    let fixture = build_with(
        Vec::new(),
        vec![job_for(&request)],
        worker(vec!["-c", "cat"], 5_000),
        true,
    );
    let shutdown = ShutdownState::new();
    let running = tokio::spawn(Arc::clone(&fixture.orchestrator).run(shutdown.clone()));

    let updates = await_updates(&fixture, 1).await;

    assert_eq!(updates[0].status, DvmJobStatus::Failed);
    assert_eq!(
        updates[0].error,
        FieldUpdate::Set("source event not found".to_owned())
    );

    shutdown.begin_draining();
    let _ = tokio::time::timeout(Duration::from_secs(5), running).await;
}

#[tokio::test]
async fn a_reply_for_an_untracked_job_changes_nothing() {
    let unknown = "ab".repeat(32);
    let script =
        format!("printf '%s\\n' '{{\"id\":\"{unknown}\",\"content\":\"nope\"}}'; sleep 60");
    let fixture = build_with(
        Vec::new(),
        Vec::new(),
        worker(vec!["-c", &script], 5_000),
        true,
    );
    let shutdown = ShutdownState::new();
    let running = tokio::spawn(Arc::clone(&fixture.orchestrator).run(shutdown.clone()));

    tokio::time::sleep(Duration::from_millis(300)).await;

    assert!(fixture.jobs.updates().is_empty(), "no job changed");
    assert!(fixture.jobs.assigned().is_empty(), "no job was assigned");
    assert!(fixture.events.creates().is_empty(), "nothing was published");

    shutdown.begin_draining();
    let _ = tokio::time::timeout(Duration::from_secs(5), running).await;
}

#[tokio::test]
async fn a_worker_that_exits_fails_every_in_flight_job() {
    let fixture = build(worker(vec!["-c", "read line; exit 3"], 5_000), true);
    let shutdown = ShutdownState::new();
    let running = tokio::spawn(Arc::clone(&fixture.orchestrator).run(shutdown.clone()));

    let updates = await_updates(&fixture, 1).await;

    assert_eq!(updates[0].status, DvmJobStatus::Failed);
    assert_eq!(
        updates[0].error,
        FieldUpdate::Set("worker exited (code=3, signal=null)".to_owned())
    );

    shutdown.begin_draining();
    let _ = tokio::time::timeout(Duration::from_secs(5), running).await;
}

#[tokio::test]
async fn shutdown_fails_in_flight_jobs_before_the_child_goes() {
    let fixture = build(worker(vec!["-c", "sleep 60"], 5_000), true);
    let shutdown = ShutdownState::new();
    let running = tokio::spawn(Arc::clone(&fixture.orchestrator).run(shutdown.clone()));

    tokio::time::timeout(Duration::from_secs(10), async {
        while fixture.jobs.assigned().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the job is dispatched");

    shutdown.begin_draining();

    let updates = await_updates(&fixture, 1).await;
    assert_eq!(updates[0].status, DvmJobStatus::Failed);
    assert_eq!(
        updates[0].error,
        FieldUpdate::Set("worker shutting down".to_owned())
    );

    let result = tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .expect("the run loop ends")
        .expect("join");
    assert!(result.is_ok(), "a drain is not an error");
}

#[test]
fn the_capture_poll_interval_and_job_timeout_are_the_defaults() {
    assert_eq!(DEFAULT_POLL_INTERVAL_MS, 2_000);
    assert_eq!(DEFAULT_JOB_TIMEOUT_MS, 60_000);
    assert_eq!(DISPATCH_BATCH_SIZE, 10);
}
