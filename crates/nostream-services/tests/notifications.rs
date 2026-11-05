//! The notification outbox, the dispatcher's skips and envelope, and the retention prune.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use chrono::{DateTime, TimeDelta, Utc};
use nostream_config::notifications::{
    AdminNotificationsSettings, OperatorNotificationChannelType, OperatorNotificationEventToggles,
};
use nostream_config::settings::AdminSettings;
use nostream_services::services::notification_outbox_service::{
    NOTIFICATION_OUTBOX_BATCH_SIZE, NotificationOutboxService,
};
use nostream_services::services::operator_notification_service::{
    DispatchContext, NotificationDispatcher, OperatorNotificationService,
};
use nostream_services::services::payments_service::PaymentsService;
use nostream_services::testing;
use nostream_services::unavailable::ServiceStores;
use nostream_services::workers::maintenance::{MaintenanceRunner, MaintenanceTasks};
use nostream_relay::relay_key::RelayKeySource;
use nostream_storage::repositories::NotificationDeliveryStatus;
use tokio::sync::broadcast;

const NOW_MS: u64 = 1_700_000_000_000;

fn target(
    id: &str,
    target_type: OperatorNotificationChannelType,
    url: &str,
) -> nostream_config::notifications::OperatorNotificationTarget {
    testing::target(id, target_type, Some(url))
}

#[tokio::test]
async fn the_outbox_walk_claims_twenty_and_marks_each_message() {
    let outbox = testing::InMemoryOutboxRepository::new();
    let dispatcher = testing::RecordingDispatcher::new();
    let messages = (0..20)
        .map(|index| testing::outbox_message(&format!("outbox-{index}"), 1))
        .collect();
    outbox.set_claim(messages);

    dispatcher.fail_for("outbox-3");
    dispatcher.fail_for("outbox-7");

    let service = NotificationOutboxService::new(outbox.clone(), dispatcher.clone(), 5, 1_000);
    let delivered = service.process_batch(20).await.expect("the walk");

    assert_eq!(outbox.claim_limits(), vec![20]);
    assert_eq!(delivered, 18);
    assert_eq!(outbox.delivered().len(), 18);
    assert_eq!(outbox.failed().len(), 2);
    for (id, reason, attempt, max_attempts, base_delay) in outbox.failed() {
        assert!(id == "outbox-3" || id == "outbox-7");
        assert!(reason.contains("failed for"));
        assert_eq!(attempt, 2, "attempt_count + 1");
        assert_eq!(max_attempts, 5);
        assert_eq!(base_delay, 1_000);
    }

    let empty = testing::InMemoryOutboxRepository::new();
    let dispatcher = testing::RecordingDispatcher::new();
    let service = NotificationOutboxService::new(empty.clone(), dispatcher.clone(), 5, 1_000);

    assert_eq!(service.process_batch(20).await.expect("the walk"), 0);
    assert_eq!(empty.delivered(), Vec::<String>::new());
    assert!(dispatcher.calls().is_empty());
    assert_eq!(NOTIFICATION_OUTBOX_BATCH_SIZE, 20);
}

fn notifications_with(
    enabled: bool,
    targets: Vec<nostream_config::notifications::OperatorNotificationTarget>,
) -> AdminNotificationsSettings {
    testing::notifications(enabled, targets)
}

fn settings_with(notifications: AdminNotificationsSettings) -> nostream_config::Settings {
    let mut settings = testing::settings();
    settings.admin = Some(AdminSettings {
        enabled: false,
        password_hash: None,
        session_ttl_seconds: None,
        nip98: None,
        notifications: Some(notifications),
    });

    settings
}

#[tokio::test]
async fn the_dispatcher_skips_and_builds_the_capture_envelope() {
    let http = testing::RecordingHttpClient::new();
    let delivery_log = testing::InMemoryDeliveryLogRepository::new();
    let payload = serde_json::json!({ "invoiceId": "invoice-1" });
    let context = DispatchContext::new();

    // Disabled.
    let dispatcher = OperatorNotificationService::new(
        Arc::new(settings_with(notifications_with(
            false,
            vec![target(
                "ops",
                OperatorNotificationChannelType::Http,
                "https://relay.example.com/notify",
            )],
        ))),
        None,
        delivery_log.clone(),
        http.clone(),
        testing::clock(NOW_MS),
    );
    dispatcher
        .dispatch("admission.invoice.created", &payload, &context)
        .await
        .expect("disabled is not an error");
    assert!(http.calls().is_empty());

    // A false toggle.
    let toggles = OperatorNotificationEventToggles {
        admission_invoice_created: Some(false),
        ..OperatorNotificationEventToggles::default()
    };
    let mut notifications = notifications_with(
        true,
        vec![target(
            "ops",
            OperatorNotificationChannelType::Http,
            "https://relay.example.com/notify",
        )],
    );
    notifications.events = toggles.clone();
    let dispatcher = OperatorNotificationService::new(
        Arc::new(settings_with(notifications)),
        None,
        delivery_log.clone(),
        http.clone(),
        testing::clock(NOW_MS),
    );
    dispatcher
        .dispatch("admission.invoice.created", &payload, &context)
        .await
        .expect("a false toggle is not an error");
    assert!(http.calls().is_empty());

    // No enabled targets.
    let mut disabled_target = target(
        "ops",
        OperatorNotificationChannelType::Http,
        "https://relay.example.com/notify",
    );
    disabled_target.enabled = Some(false);
    let dispatcher = OperatorNotificationService::new(
        Arc::new(settings_with(notifications_with(true, vec![disabled_target]))),
        None,
        delivery_log.clone(),
        http.clone(),
        testing::clock(NOW_MS),
    );
    dispatcher
        .dispatch("admission.invoice.created", &payload, &context)
        .await
        .expect("no targets is not an error");
    assert!(http.calls().is_empty());

    // Every target already has a success row for this outbox id.
    delivery_log.set_successful("outbox-1", vec!["ops".to_owned()]);
    let dispatcher = OperatorNotificationService::new(
        Arc::new(settings_with(notifications_with(
            true,
            vec![target(
                "ops",
                OperatorNotificationChannelType::Http,
                "https://relay.example.com/notify",
            )],
        ))),
        None,
        delivery_log.clone(),
        http.clone(),
        testing::clock(NOW_MS),
    );
    let context = DispatchContext {
        outbox_id: Some("outbox-1".to_owned()),
        attempt_number: 1,
    };
    dispatcher
        .dispatch("admission.invoice.created", &payload, &context)
        .await
        .expect("already delivered is not an error");
    assert!(http.calls().is_empty());

    // The normal path: one good target and one failing target.
    let http = testing::RecordingHttpClient::new();
    let delivery_log = testing::InMemoryDeliveryLogRepository::new();
    http.respond(204, "");
    http.fail(None, "connection refused");
    let dispatcher = OperatorNotificationService::new(
        Arc::new(settings_with(notifications_with(
            true,
            vec![
                target(
                    "good",
                    OperatorNotificationChannelType::Http,
                    "https://relay.example.com/good",
                ),
                target(
                    "bad",
                    OperatorNotificationChannelType::Http,
                    "https://relay.example.com/bad",
                ),
            ],
        ))),
        None,
        delivery_log.clone(),
        http.clone(),
        testing::clock(NOW_MS),
    );

    let error = dispatcher
        .dispatch("admission.invoice.created", &payload, &DispatchContext::new())
        .await
        .expect_err("the failing target errors");
    assert!(error.to_string().contains("bad:"));
    assert!(
        !error.to_string().contains("good:"),
        "only the failed target is named: {error}"
    );

    let calls = http.calls();
    assert_eq!(calls.len(), 2);
    let body: serde_json::Value =
        serde_json::from_str(calls[0].body.as_deref().expect("a body")).expect("json");
    assert_eq!(body["event"], serde_json::json!("admission.invoice.created"));
    assert_eq!(body["relay"], serde_json::json!("wss://relay.example.com"));
    assert_eq!(body["data"], payload);
    assert!(
        body["timestamp"]
            .as_str()
            .expect("a timestamp")
            .ends_with('Z')
    );

    let appended = delivery_log.appended();
    assert_eq!(appended.len(), 2);
    assert_eq!(appended[0].target_id, "good");
    assert_eq!(appended[0].status, NotificationDeliveryStatus::Success);
    assert_eq!(appended[1].target_id, "bad");
    assert_eq!(appended[1].status, NotificationDeliveryStatus::Failed);
}

fn runner(settings: nostream_config::Settings) -> (MaintenanceRunner, Arc<testing::InMemoryDeliveryLogRepository>, Arc<testing::InMemoryOutboxRepository>) {
    let delivery_log = testing::InMemoryDeliveryLogRepository::new();
    let outbox = testing::InMemoryOutboxRepository::new();
    let stores = ServiceStores {
        events: testing::InMemoryEventRepository::new(),
        users: testing::InMemoryUserRepository::new(),
        invoices: testing::InMemoryInvoiceRepository::new(),
        nip05: testing::InMemoryNip05Repository::new(),
        dvm_jobs: testing::InMemoryDvmJobRepository::new(),
        notification_outbox: Arc::clone(&outbox)
            as Arc<dyn nostream_storage::repositories::NotificationOutboxRepository>,
        notification_delivery_log: Arc::clone(&delivery_log)
            as Arc<dyn nostream_storage::repositories::NotificationDeliveryLogRepository>,
    };
    let settings = Arc::new(settings);
    let clock = testing::clock(NOW_MS);
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
        Arc::clone(&delivery_log)
            as Arc<dyn nostream_storage::repositories::NotificationDeliveryLogRepository>,
        testing::RecordingHttpClient::new(),
        Arc::clone(&clock),
    ));
    let outbox_service = Arc::new(NotificationOutboxService::new(
        Arc::clone(&outbox)
            as Arc<dyn nostream_storage::repositories::NotificationOutboxRepository>,
        dispatcher.clone(),
        dispatcher.max_attempts(),
        dispatcher.base_delay_ms(),
    ));

    (
        MaintenanceRunner::new(
            settings,
            clock,
            Arc::new(stores),
            testing::FakeNip05Fetch::new(),
            outbox_service,
            payments,
        ),
        delivery_log,
        outbox,
    )
}

#[tokio::test]
async fn the_prune_uses_thirty_days_or_the_configured_value() {
    for (configured, days) in [(None, 30i64), (Some(7), 7)] {
        let mut notifications = notifications_with(false, Vec::new());
        notifications.delivery_log_retention_days = configured;
        let (runner, delivery_log, outbox) = runner(settings_with(notifications));

        runner
            .process_notification_outbox()
            .await
            .expect("the pass");

        let now = DateTime::from_timestamp_millis(NOW_MS as i64).expect("a date");
        let expected = now - TimeDelta::days(days);

        let delivery_cutoffs = delivery_log.cutoffs();
        let outbox_cutoffs = outbox.terminal_cutoffs();
        assert_eq!(delivery_cutoffs.len(), 1);
        assert_eq!(outbox_cutoffs.len(), 1);
        assert_eq!(delivery_cutoffs[0], expected);
        assert_eq!(outbox_cutoffs[0], expected);
        assert!(delivery_cutoffs[0] < Utc::now());
    }
}
