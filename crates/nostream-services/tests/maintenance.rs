//! The maintenance pass: tick overlap, the retention guard, the purge timeout, the step
//! order, the startup notification and the NIP-05 batch.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nostream_config::settings::{
    EventLimits, EventRetentionKindLimits, EventRetentionLimits, EventRetentionPubkeyLimits,
    Limits, Nip05Mode, Nip05Settings,
};
use nostream_core::lifecycle::ShutdownState;
use nostream_core::{Kind, KindSelector, SettingsPubkey};
use nostream_relay::relay_key::RelayKeySource;
use nostream_services::error::ServicesError;
use nostream_services::services::maintenance_service::MaintenanceService;
use nostream_services::services::notification_outbox_service::NotificationOutboxService;
use nostream_services::services::operator_notification_service::{
    DispatchContext, NotificationDispatcher, OperatorNotificationService, enqueue_relay_restarted,
};
use nostream_services::services::payments_service::PaymentsService;
use nostream_services::testing;
use nostream_services::unavailable::ServiceStores;
use nostream_services::workers::maintenance::{
    MaintenanceRunner, MaintenanceTasks, MaintenanceWorker, NIP05_REVERIFICATION_BATCH_SIZE,
};
use nostream_storage::repositories::{
    EventRepository, NotificationDeliveryLogRepository, NotificationOutboxRepository,
};
use tokio::sync::{Semaphore, broadcast};

struct ScriptedTasks {
    log: Arc<Mutex<Vec<String>>>,
    gate: Arc<Semaphore>,
    purge_delay: Option<Duration>,
    passes: AtomicUsize,
}

impl ScriptedTasks {
    fn new(gate: Arc<Semaphore>, purge_delay: Option<Duration>) -> Arc<Self> {
        Arc::new(Self {
            log: Arc::new(Mutex::new(Vec::new())),
            gate,
            purge_delay,
            passes: AtomicUsize::new(0),
        })
    }

    fn record(&self, entry: &str) {
        self.log
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(entry.to_owned());
    }

    fn entries(&self) -> Vec<String> {
        self.log
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl MaintenanceTasks for ScriptedTasks {
    fn clear_old_events(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + '_>> {
        Box::pin(async move {
            self.record("purge started");

            if let Some(delay) = self.purge_delay {
                tokio::time::sleep(delay).await;
            } else {
                let permit = self
                    .gate
                    .acquire()
                    .await
                    .map_err(|_| ServicesError::Configuration("the gate closed".to_owned()))?;
                permit.forget();
            }

            self.record("purge finished");

            Ok(())
        })
    }

    fn reverify_nip05(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + '_>> {
        Box::pin(async move {
            self.passes.fetch_add(1, Ordering::SeqCst);
            self.record("nip05");

            Ok(())
        })
    }

    fn process_notification_outbox(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + '_>> {
        Box::pin(async move {
            self.record("outbox");

            Ok(())
        })
    }

    fn walk_invoices(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + '_>> {
        Box::pin(async move {
            self.record("invoices");

            Ok(())
        })
    }
}

fn payments_settings() -> nostream_config::Settings {
    let mut settings = testing::settings();
    settings.payments = Some(nostream_config::settings::Payments {
        enabled: true,
        processor: nostream_config::settings::Processor::Lnurl,
        fee_schedules: nostream_config::settings::FeeSchedules {
            admission: Vec::new(),
            publication: None,
        },
        invoice_expiry_seconds: None,
        subscription_plans: None,
    });

    settings
}

#[tokio::test]
async fn an_overlapping_tick_during_a_pass_is_skipped() {
    let gate = Arc::new(Semaphore::new(0));
    let tasks = ScriptedTasks::new(Arc::clone(&gate), None);
    let shutdown = ShutdownState::new();
    let worker = Arc::new(MaintenanceWorker::new(
        Arc::new(testing::settings()),
        Arc::clone(&tasks) as Arc<dyn MaintenanceTasks>,
        Duration::from_millis(20),
        Duration::from_secs(1),
    ));

    let task = tokio::spawn(Arc::clone(&worker).run(shutdown.clone()));

    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(
        tasks.passes.load(Ordering::SeqCst),
        1,
        "a pass is running and the ticks are skipped"
    );

    gate.add_permits(100);
    tokio::time::sleep(Duration::from_millis(200)).await;

    assert!(
        tasks.passes.load(Ordering::SeqCst) >= 2,
        "the next tick runs after the pass ends, got {}",
        tasks.passes.load(Ordering::SeqCst)
    );

    shutdown.begin_draining();
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("the worker stops")
        .expect("join")
        .expect("Ok");
}

#[tokio::test]
async fn the_retention_guard_skips_every_disabled_value_and_forwards_the_whitelists() {
    let events = testing::InMemoryEventRepository::new();
    let event_store: Arc<dyn EventRepository> = Arc::clone(&events) as Arc<dyn EventRepository>;

    for max_days in [None, Some(-1i64), Some(0i64)] {
        let mut settings = testing::settings();
        settings.limits = Some(retention_limits(max_days));

        MaintenanceService::new(Arc::clone(&event_store), Arc::new(settings))
            .clear_old_events()
            .await
            .expect("the pass");
        assert!(
            events.purge_calls().is_empty(),
            "max_days {max_days:?} must not call the repository"
        );
    }

    let mut settings = testing::settings();
    settings.limits = Some(retention_limits(Some(7)));
    MaintenanceService::new(Arc::clone(&event_store), Arc::new(settings))
        .clear_old_events()
        .await
        .expect("the pass");

    let calls = events.purge_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].max_days, Some(7));
    assert_eq!(
        calls[0].kind_whitelist.as_deref(),
        Some(&[KindSelector::Single(Kind(62))][..])
    );
    assert_eq!(
        calls[0].pubkey_whitelist.as_deref(),
        Some(&[SettingsPubkey("abc".to_owned())][..])
    );
}

fn retention_limits(max_days: Option<i64>) -> Limits {
    Limits {
        event: Some(EventLimits {
            retention: Some(EventRetentionLimits {
                max_days,
                kind: Some(EventRetentionKindLimits {
                    whitelist: Some(vec![KindSelector::Single(Kind(62))]),
                }),
                pubkey: Some(EventRetentionPubkeyLimits {
                    whitelist: Some(vec![SettingsPubkey("abc".to_owned())]),
                }),
            }),
            ..Default::default()
        }),
        ..Default::default()
    }
}

#[tokio::test]
async fn a_slow_purge_that_outlives_the_timeout_does_not_fail_the_pass() {
    let tasks = ScriptedTasks::new(
        Arc::new(Semaphore::new(0)),
        Some(Duration::from_millis(200)),
    );
    let worker = MaintenanceWorker::new(
        Arc::new(payments_settings()),
        Arc::clone(&tasks) as Arc<dyn MaintenanceTasks>,
        Duration::from_secs(60),
        Duration::from_millis(20),
    );

    let outcome = worker.run_pass().await;

    assert!(outcome.purge_timed_out);
    assert_eq!(
        tasks.entries(),
        vec!["purge started", "nip05", "outbox", "invoices"]
    );
}

#[tokio::test]
async fn the_pass_order_is_the_captures() {
    let tasks = ScriptedTasks::new(Arc::new(Semaphore::new(0)), Some(Duration::from_millis(30)));
    let worker = MaintenanceWorker::new(
        Arc::new(payments_settings()),
        Arc::clone(&tasks) as Arc<dyn MaintenanceTasks>,
        Duration::from_secs(60),
        Duration::from_secs(1),
    );

    let outcome = worker.run_pass().await;

    assert!(!outcome.purge_timed_out);
    assert_eq!(
        tasks.entries(),
        vec![
            "purge started",
            "nip05",
            "outbox",
            "invoices",
            "purge finished"
        ]
    );
}

#[tokio::test]
async fn the_relay_restarted_notification_is_one_enqueue_and_obeys_its_toggle() {
    let outbox = testing::InMemoryOutboxRepository::new();
    let delivery_log = testing::InMemoryDeliveryLogRepository::new();
    let stores = ServiceStores {
        events: testing::InMemoryEventRepository::new(),
        users: testing::InMemoryUserRepository::new(),
        invoices: testing::InMemoryInvoiceRepository::new(),
        nip05: testing::InMemoryNip05Repository::new(),
        dvm_jobs: testing::InMemoryDvmJobRepository::new(),
        notification_outbox: Arc::clone(&outbox) as Arc<dyn NotificationOutboxRepository>,
        notification_delivery_log: Arc::clone(&delivery_log)
            as Arc<dyn NotificationDeliveryLogRepository>,
    };

    // R8: the process's one row, through the same function `serve` calls.
    enqueue_relay_restarted(&stores, "0.1.0", 8008)
        .await
        .expect("the startup enqueue");

    let enqueued = outbox.enqueued();
    assert_eq!(enqueued.len(), 1, "one row per process");
    assert_eq!(enqueued[0].0, "relay.restarted");
    assert_eq!(
        enqueued[0].1,
        serde_json::json!({ "version": "0.1.0", "relayPort": 8008 })
    );

    let delivery_store: Arc<dyn NotificationDeliveryLogRepository> =
        Arc::clone(&delivery_log) as Arc<dyn NotificationDeliveryLogRepository>;
    let http = testing::RecordingHttpClient::new();
    let mut settings = testing::settings();

    let mut notifications = testing::notifications(
        true,
        vec![testing::target(
            "ops",
            nostream_config::notifications::OperatorNotificationChannelType::Http,
            Some("https://relay.example.com/notify"),
        )],
    );
    notifications.events.relay_restarted = Some(false);
    settings.admin = Some(nostream_config::settings::AdminSettings {
        enabled: false,
        password_hash: None,
        session_ttl_seconds: None,
        nip98: None,
        notifications: Some(notifications),
    });

    let dispatcher = OperatorNotificationService::new(
        Arc::new(settings),
        None,
        Arc::clone(&delivery_store),
        http.clone(),
        testing::clock(1_700_000_000_000),
    );
    let payload = enqueued[0].1.clone();

    let context = DispatchContext::new();
    dispatcher
        .dispatch("relay.restarted", &payload, &context)
        .await
        .expect("the disabled toggle is not an error");

    assert_eq!(outbox.enqueued().len(), 1);
    assert!(http.calls().is_empty(), "a false toggle delivers nothing");
    assert!(delivery_log.appended().is_empty());

    let mut enabled = testing::settings();
    let mut notifications = testing::notifications(
        true,
        vec![testing::target(
            "ops",
            nostream_config::notifications::OperatorNotificationChannelType::Http,
            Some("https://relay.example.com/notify"),
        )],
    );
    notifications.events.relay_restarted = Some(true);
    enabled.admin = Some(nostream_config::settings::AdminSettings {
        enabled: false,
        password_hash: None,
        session_ttl_seconds: None,
        nip98: None,
        notifications: Some(notifications),
    });
    http.respond(204, "");

    let dispatcher = OperatorNotificationService::new(
        Arc::new(enabled),
        None,
        Arc::clone(&delivery_store),
        http.clone(),
        testing::clock(1_700_000_000_000),
    );
    dispatcher
        .dispatch("relay.restarted", &payload, &context)
        .await
        .expect("delivered");

    assert_eq!(http.calls().len(), 1);
    assert_eq!(delivery_log.appended().len(), 1);
}

fn runner(
    settings: nostream_config::Settings,
    fetch: Arc<testing::FakeNip05Fetch>,
) -> (MaintenanceRunner, Arc<testing::InMemoryNip05Repository>) {
    let nip05 = testing::InMemoryNip05Repository::new();
    let stores = ServiceStores {
        events: testing::InMemoryEventRepository::new(),
        users: testing::InMemoryUserRepository::new(),
        invoices: testing::InMemoryInvoiceRepository::new(),
        nip05: Arc::clone(&nip05)
            as Arc<dyn nostream_storage::repositories::Nip05VerificationRepository>,
        dvm_jobs: testing::InMemoryDvmJobRepository::new(),
        notification_outbox: testing::InMemoryOutboxRepository::new(),
        notification_delivery_log: testing::InMemoryDeliveryLogRepository::new(),
    };
    let settings = Arc::new(settings);
    let clock = testing::clock(1_700_000_000_000);
    let (hub, _receiver) = broadcast::channel(16);
    let processor = testing::RecordingProcessor::new();
    let payments = Arc::new(PaymentsService::new(
        Arc::clone(&settings),
        Arc::clone(&clock),
        Arc::new(RelayKeySource::from_values(None, None)),
        Arc::new(stores.clone()),
        hub,
        processor,
    ));
    let dispatcher = Arc::new(OperatorNotificationService::new(
        Arc::clone(&settings),
        None,
        Arc::clone(&stores.notification_delivery_log),
        testing::RecordingHttpClient::new(),
        Arc::clone(&clock),
    ));
    let outbox = Arc::new(NotificationOutboxService::new(
        Arc::clone(&stores.notification_outbox),
        dispatcher.clone(),
        dispatcher.max_attempts(),
        dispatcher.base_delay_ms(),
    ));

    (
        MaintenanceRunner::new(
            Arc::clone(&settings),
            clock,
            Arc::new(stores),
            fetch,
            outbox,
            payments,
        ),
        nip05,
    )
}

#[tokio::test]
async fn the_nip05_batch_is_skipped_when_disabled_and_read_with_the_captures_defaults() {
    let fetch = testing::FakeNip05Fetch::new();

    let mut settings = testing::settings();
    settings.nip05 = Some(Nip05Settings {
        mode: Nip05Mode::Disabled,
        verify_expiration: None,
        verify_update_frequency: None,
        max_consecutive_failures: None,
        domain_whitelist: None,
        domain_blacklist: None,
    });
    let (runner, repository) = self::runner(settings, Arc::clone(&fetch));
    runner.reverify_nip05().await.expect("the pass");
    assert!(repository.pending_calls().is_empty());

    let mut settings = testing::settings();
    settings.nip05 = Some(Nip05Settings {
        mode: Nip05Mode::Enabled,
        verify_expiration: None,
        verify_update_frequency: None,
        max_consecutive_failures: None,
        domain_whitelist: None,
        domain_blacklist: None,
    });
    let (runner, repository) = self::runner(settings, Arc::clone(&fetch));

    fetch.respond(
        200,
        br#"{"names":{"alice":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#.to_vec(),
    );
    fetch.fail("connection reset");

    let mut verified = verification("alice@example.com", 0);
    verified.is_verified = true;
    verified.last_verified_at = Some(chrono::Utc::now());
    repository.set_pending(vec![verified]);

    runner.reverify_nip05().await.expect("the pass");

    assert_eq!(
        repository.pending_calls(),
        vec![(86_400_000, 20, NIP05_REVERIFICATION_BATCH_SIZE)]
    );

    let upserts = repository.upserts();
    assert_eq!(upserts.len(), 1);
    assert!(upserts[0].is_verified);
    assert_eq!(upserts[0].failure_count, 0);
    assert!(upserts[0].last_verified_at.is_some());

    // A transient error bumps the count and keeps the previous verification.
    let mut verified = verification("alice@example.com", 0);
    verified.is_verified = true;
    let last_verified_at = Some(chrono::Utc::now());
    verified.last_verified_at = last_verified_at;
    let (runner, repository) = {
        let mut settings = testing::settings();
        settings.nip05 = Some(Nip05Settings {
            mode: Nip05Mode::Enabled,
            verify_expiration: None,
            verify_update_frequency: None,
            max_consecutive_failures: None,
            domain_whitelist: None,
            domain_blacklist: None,
        });
        let (runner, repository) = self::runner(settings, Arc::clone(&fetch));
        repository.set_pending(vec![verified]);
        (runner, repository)
    };
    runner.reverify_nip05().await.expect("the pass");

    let upserts = repository.upserts();
    assert_eq!(upserts[0].failure_count, 1);
    assert!(upserts[0].is_verified);
    assert_eq!(upserts[0].last_verified_at, last_verified_at);
}

fn verification(
    nip05: &str,
    failure_count: i32,
) -> nostream_storage::repositories::Nip05Verification {
    use nostream_storage::repositories::Nip05Verification;

    let now = chrono::Utc::now();

    Nip05Verification {
        pubkey: testing::pubkey(0xaa),
        nip05: nip05.to_owned(),
        domain: "example.com".to_owned(),
        is_verified: false,
        last_verified_at: None,
        last_checked_at: now,
        failure_count,
        created_at: now,
        updated_at: now,
    }
}
