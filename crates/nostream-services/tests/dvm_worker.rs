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
    DISPATCH_BATCH_SIZE, DvmOrchestrator, DvmWorkerConfig, dvm_specs,
};
use nostream_storage::repositories::{DvmJob, DvmJobStatus};
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
    let events = testing::InMemoryEventRepository::with_events([request.clone()]);
    let jobs = testing::InMemoryDvmJobRepository::new();
    jobs.set_jobs(vec![job_for(&request)]);
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
