//! The pending-invoice walk: the 404 rule, the page offset and confirm-on-change.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use chrono::DateTime;
use nostream_config::settings::{FeeSchedules, Payments};
use nostream_core::clock::TestClock;
use nostream_relay::relay_key::RelayKeySource;
use nostream_services::payments::InvoiceUpdate;
use nostream_services::services::payments_service::PaymentsService;
use nostream_services::testing;
use nostream_services::unavailable::ServiceStores;
use nostream_storage::repositories::{Invoice, InvoiceStatus, InvoiceUnit};
use tokio::sync::broadcast;

const NOW_MS: u64 = 1_700_000_000_000;

struct Fixture {
    service: PaymentsService,
    invoices: Arc<testing::InMemoryInvoiceRepository>,
    outbox: Arc<testing::InMemoryOutboxRepository>,
    events: Arc<testing::InMemoryEventRepository>,
    processor: Arc<testing::RecordingProcessor>,
}

fn build(with_key: bool) -> Fixture {
    let users = testing::InMemoryUserRepository::new();
    let invoices = testing::InMemoryInvoiceRepository::new();
    let outbox = testing::InMemoryOutboxRepository::new();
    let events = testing::InMemoryEventRepository::new();
    let processor = testing::RecordingProcessor::new();
    let stores = Arc::new(ServiceStores {
        events: Arc::clone(&events) as Arc<dyn nostream_storage::repositories::EventRepository>,
        users,
        invoices: Arc::clone(&invoices)
            as Arc<dyn nostream_storage::repositories::InvoiceRepository>,
        nip05: testing::InMemoryNip05Repository::new(),
        dvm_jobs: testing::InMemoryDvmJobRepository::new(),
        notification_outbox: Arc::clone(&outbox)
            as Arc<dyn nostream_storage::repositories::NotificationOutboxRepository>,
        notification_delivery_log: testing::InMemoryDeliveryLogRepository::new(),
    });
    let (hub, _receiver) = broadcast::channel(16);
    let mut settings = testing::settings();
    settings.payments = Some(Payments {
        enabled: true,
        processor: nostream_config::settings::Processor::Lnurl,
        fee_schedules: FeeSchedules {
            admission: Vec::new(),
            publication: None,
        },
        invoice_expiry_seconds: None,
        subscription_plans: None,
    });
    let clock = Arc::new(TestClock::new(NOW_MS));
    let keys = if with_key {
        RelayKeySource::from_values(Some("01".repeat(32)), None)
    } else {
        RelayKeySource::from_values(None, None)
    };

    Fixture {
        service: PaymentsService::new(
            Arc::new(settings),
            clock,
            Arc::new(keys),
            stores,
            hub,
            processor.clone(),
        ),
        invoices,
        outbox,
        events,
        processor,
    }
}

fn invoice(id: &str, status: InvoiceStatus, expires_at: Option<i64>) -> Invoice {
    Invoice {
        id: id.to_owned(),
        pubkey: testing::pubkey(1),
        bolt11: "lnbc1".to_owned(),
        amount_requested: 1_500,
        amount_paid: None,
        unit: InvoiceUnit::Msats,
        status,
        description: "admission".to_owned(),
        confirmed_at: None,
        expires_at: expires_at.and_then(|seconds| DateTime::from_timestamp(seconds, 0)),
        updated_at: DateTime::from_timestamp(1_700_000_000, 0).expect("a date"),
        created_at: DateTime::from_timestamp(1_700_000_000, 0).expect("a date"),
        verify_url: None,
    }
}

fn now_seconds() -> i64 {
    (NOW_MS / 1_000) as i64
}

#[tokio::test]
async fn a_not_found_response_expires_an_expired_invoice_and_leaves_a_live_or_failing_one_alone() {
    let fixture = build(false);
    fixture.processor.fail_get(Some(404), "HTTP status 404");
    fixture.invoices.set_invoices(vec![
        invoice(
            "expired-1",
            InvoiceStatus::Pending,
            Some(now_seconds() - 86_400),
        ),
        invoice(
            "live-1",
            InvoiceStatus::Pending,
            Some(now_seconds() + 86_400),
        ),
    ]);

    let mut offset = 0;
    fixture
        .service
        .walk_pending_invoices(&mut offset)
        .await
        .expect("the walk");

    assert_eq!(
        fixture.invoices.status_updates(),
        vec![("expired-1".to_owned(), InvoiceStatus::Expired)]
    );
    let failed = fixture
        .outbox
        .enqueued()
        .into_iter()
        .filter(|(event, _)| event == "admission.invoice.failed")
        .collect::<Vec<_>>();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].1["reason"], serde_json::json!("expired"));
    assert_eq!(failed[0].1["invoiceId"], serde_json::json!("expired-1"));

    let fixture = build(false);
    fixture.processor.fail_get(Some(500), "HTTP status 500");
    fixture.invoices.set_invoices(vec![invoice(
        "live-1",
        InvoiceStatus::Pending,
        Some(now_seconds() + 86_400),
    )]);
    let mut offset = 0;
    fixture
        .service
        .walk_pending_invoices(&mut offset)
        .await
        .expect("the walk");
    assert!(fixture.invoices.status_updates().is_empty());
    assert!(fixture.outbox.enqueued().is_empty());
}

#[tokio::test]
async fn paging_advances_the_offset_by_ten_and_resets_on_a_short_page() {
    for (rows, expected) in [(10usize, 10u64), (9, 0), (0, 0)] {
        let fixture = build(false);
        fixture.processor.set_update(InvoiceUpdate {
            id: Some("x".to_owned()),
            status: Some(InvoiceStatus::Pending),
            ..InvoiceUpdate::default()
        });
        fixture.invoices.set_invoices(
            (0..rows)
                .map(|index| {
                    invoice(
                        &format!("invoice-{index}"),
                        InvoiceStatus::Pending,
                        Some(now_seconds() + 86_400),
                    )
                })
                .collect(),
        );

        let mut offset = 0;
        fixture
            .service
            .walk_pending_invoices(&mut offset)
            .await
            .expect("the walk");

        assert_eq!(offset, expected, "{rows} rows");
        assert_eq!(fixture.invoices.reads(), vec![(0, 10)]);
    }
}

#[tokio::test]
async fn only_a_status_change_to_completed_confirms_and_notifies() {
    let fixture = build(true);
    let confirmed_at = DateTime::from_timestamp(now_seconds(), 0).expect("a date");

    fixture.processor.set_update(InvoiceUpdate {
        id: Some("already-done".to_owned()),
        status: Some(InvoiceStatus::Completed),
        confirmed_at: Some(confirmed_at),
        ..InvoiceUpdate::default()
    });
    fixture.invoices.set_invoices(vec![invoice(
        "already-done",
        InvoiceStatus::Completed,
        Some(now_seconds() + 86_400),
    )]);

    let mut offset = 0;
    fixture
        .service
        .walk_pending_invoices(&mut offset)
        .await
        .expect("the walk");

    assert!(
        fixture.invoices.confirmations().is_empty(),
        "a completed invoice is not confirmed again"
    );
    assert!(
        fixture.events.creates().is_empty(),
        "and not notified again"
    );

    let fixture = build(true);
    fixture.processor.set_update(InvoiceUpdate {
        id: Some("pending-1".to_owned()),
        status: Some(InvoiceStatus::Completed),
        confirmed_at: Some(confirmed_at),
        ..InvoiceUpdate::default()
    });
    fixture.invoices.set_invoices(vec![invoice(
        "pending-1",
        InvoiceStatus::Pending,
        Some(now_seconds() + 86_400),
    )]);

    let mut offset = 0;
    fixture
        .service
        .walk_pending_invoices(&mut offset)
        .await
        .expect("the walk");

    let confirmations = fixture.invoices.confirmations();
    assert_eq!(confirmations.len(), 1);
    assert_eq!(
        confirmations[0].1, 1_500,
        "the update omits amountPaid, so the stored amountRequested is used"
    );
    assert_eq!(fixture.events.creates().len(), 1, "the update notification");
    assert_eq!(
        fixture.events.creates()[0].event.kind,
        nostream_core::Kind(402)
    );
}
