//! The payments service: expiry arithmetic, invoice creation, confirmation and the two
//! invoice notifications.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use chrono::{DateTime, Datelike, Local, TimeZone};
use nostream_config::settings::{FeeSchedule, FeeScheduleWhitelists, FeeSchedules, Payments};
use nostream_core::clock::{Clock, TestClock};
use nostream_core::{Kind, SettingsPubkey};
use nostream_relay::relay_key::RelayKeySource;
use nostream_services::invoice::{
    DEFAULT_INVOICE_EXPIRY_SECONDS, MAX_INVOICE_EXPIRY_SECONDS, is_expired_invoice,
    resolve_invoice_expiry, resolve_invoice_expiry_seconds,
};
use nostream_services::payments::ProcessorInvoice;
use nostream_services::services::payments_service::PaymentsService;
use nostream_services::testing;
use nostream_services::unavailable::ServiceStores;
use nostream_storage::repositories::{Invoice, InvoiceStatus, InvoiceUnit};
use tokio::sync::broadcast;

const NOW_MS: u64 = 1_700_000_000_000;

struct Fixture {
    service: PaymentsService,
    users: Arc<testing::InMemoryUserRepository>,
    invoices: Arc<testing::InMemoryInvoiceRepository>,
    outbox: Arc<testing::InMemoryOutboxRepository>,
    events: Arc<testing::InMemoryEventRepository>,
    trace: testing::Trace,
    processor: Arc<testing::RecordingProcessor>,
    hub: broadcast::Sender<Arc<nostream_core::Event>>,
    clock: Arc<TestClock>,
}

fn build(settings: nostream_config::Settings, with_key: bool) -> Fixture {
    let users = testing::InMemoryUserRepository::new();
    let invoices = testing::InMemoryInvoiceRepository::new();
    let outbox = testing::InMemoryOutboxRepository::new();
    let events = testing::InMemoryEventRepository::new();
    let processor = testing::RecordingProcessor::new();
    let trace = testing::Trace::new();

    users.set_trace(trace.clone());
    invoices.set_trace(trace.clone());
    outbox.set_trace(trace.clone());
    processor.set_trace(trace.clone());

    let stores = Arc::new(ServiceStores {
        events: Arc::clone(&events) as Arc<dyn nostream_storage::repositories::EventRepository>,
        users: Arc::clone(&users) as Arc<dyn nostream_storage::repositories::UserRepository>,
        invoices: Arc::clone(&invoices)
            as Arc<dyn nostream_storage::repositories::InvoiceRepository>,
        nip05: testing::InMemoryNip05Repository::new(),
        dvm_jobs: testing::InMemoryDvmJobRepository::new(),
        notification_outbox: Arc::clone(&outbox)
            as Arc<dyn nostream_storage::repositories::NotificationOutboxRepository>,
        notification_delivery_log: testing::InMemoryDeliveryLogRepository::new(),
    });
    let (hub, _receiver) = broadcast::channel(16);
    let clock = Arc::new(TestClock::new(NOW_MS));
    let keys = if with_key {
        RelayKeySource::from_values(Some("01".repeat(32)), None)
    } else {
        RelayKeySource::from_values(None, None)
    };

    let service = PaymentsService::new(
        Arc::new(settings),
        clock.clone(),
        Arc::new(keys),
        stores,
        hub.clone(),
        processor.clone(),
    );

    Fixture {
        service,
        users,
        invoices,
        outbox,
        events,
        trace,
        processor,
        hub,
        clock,
    }
}

fn payments_settings(fees: Vec<FeeSchedule>) -> nostream_config::Settings {
    let mut settings = testing::settings();
    settings.payments = Some(Payments {
        enabled: true,
        processor: nostream_config::settings::Processor::Lnurl,
        fee_schedules: FeeSchedules {
            admission: fees,
            publication: None,
        },
        invoice_expiry_seconds: None,
        subscription_plans: None,
    });

    settings
}

fn fee(amount: i64, enabled: bool, whitelist: Vec<SettingsPubkey>) -> FeeSchedule {
    FeeSchedule {
        enabled,
        description: None,
        amount,
        whitelists: Some(FeeScheduleWhitelists {
            pubkeys: Some(whitelist),
            event_kinds: None,
        }),
    }
}

fn invoice(unit: InvoiceUnit, amount_paid: Option<i64>) -> Invoice {
    Invoice {
        id: "invoice-1".to_owned(),
        pubkey: testing::pubkey(1),
        bolt11: "lnbc1".to_owned(),
        amount_requested: 1_500,
        amount_paid,
        unit,
        status: InvoiceStatus::Completed,
        description: "admission".to_owned(),
        confirmed_at: Some(DateTime::from_timestamp(1_700_000_000, 0).expect("a date")),
        expires_at: Some(DateTime::from_timestamp(1_700_100_000, 0).expect("a date")),
        updated_at: DateTime::from_timestamp(1_700_000_000, 0).expect("a date"),
        created_at: DateTime::from_timestamp(1_700_000_000, 0).expect("a date"),
        verify_url: None,
    }
}

fn created_invoice() -> ProcessorInvoice {
    ProcessorInvoice {
        id: "invoice-1".to_owned(),
        pubkey: Some(testing::pubkey(1).to_string()),
        bolt11: "lnbc1".to_owned(),
        amount_requested: 1_500,
        description: "admission".to_owned(),
        unit: InvoiceUnit::Msats,
        status: InvoiceStatus::Pending,
        expires_at: None,
        confirmed_at: None,
        created_at: None,
        verify_url: None,
    }
}

#[test]
fn invoice_expiry_prefers_the_processor_and_caps_the_configured_fallback() {
    let created_at = DateTime::from_timestamp(1_700_000_000, 0).expect("a date");
    let now = DateTime::from_timestamp(1_800_000_000, 0).expect("a date");
    let reported = DateTime::from_timestamp(1_900_000_000, 0).expect("a date");

    assert_eq!(
        resolve_invoice_expiry(Some(reported), Some(created_at), Some(60), now),
        reported
    );
    assert_eq!(
        resolve_invoice_expiry(None, Some(created_at), None, now),
        created_at + chrono::TimeDelta::seconds(DEFAULT_INVOICE_EXPIRY_SECONDS as i64)
    );
    assert_eq!(
        resolve_invoice_expiry(None, Some(created_at), Some(0), now),
        created_at + chrono::TimeDelta::seconds(DEFAULT_INVOICE_EXPIRY_SECONDS as i64)
    );
    assert_eq!(
        resolve_invoice_expiry(
            None,
            Some(created_at),
            Some(MAX_INVOICE_EXPIRY_SECONDS + 1),
            now
        ),
        created_at + chrono::TimeDelta::seconds(MAX_INVOICE_EXPIRY_SECONDS as i64)
    );
    assert_eq!(
        resolve_invoice_expiry_seconds(Some(MAX_INVOICE_EXPIRY_SECONDS)),
        MAX_INVOICE_EXPIRY_SECONDS
    );

    assert!(is_expired_invoice(Some(now), now));
    assert!(!is_expired_invoice(
        Some(now + chrono::TimeDelta::seconds(1)),
        now
    ));
    assert!(!is_expired_invoice(None, now));
}

#[tokio::test]
async fn create_invoice_writes_in_the_capture_order_and_returns_the_row() {
    let fixture = build(payments_settings(Vec::new()), false);
    fixture.processor.set_invoice(created_invoice());

    let created = fixture
        .service
        .create_invoice(&testing::pubkey(1), 1_500, "admission")
        .await
        .expect("created");

    assert_eq!(
        fixture.trace.entries(),
        vec![
            "user.upsert",
            "processor.create_invoice",
            "invoice.upsert",
            "outbox.enqueue"
        ]
    );

    let now = DateTime::from_timestamp_millis(NOW_MS as i64).expect("a date");
    assert_eq!(created.created_at, now);
    assert_eq!(created.updated_at, now);
    assert_eq!(
        created.expires_at,
        Some(now + chrono::TimeDelta::seconds(DEFAULT_INVOICE_EXPIRY_SECONDS as i64))
    );
    assert_eq!(created.status, InvoiceStatus::Pending);

    let enqueued = fixture.outbox.enqueued();
    assert_eq!(enqueued.len(), 1);
    assert_eq!(enqueued[0].0, "admission.invoice.created");
    assert_eq!(
        enqueued[0].1["amountRequested"],
        serde_json::json!("1500"),
        "the amount request is a string"
    );
    assert_eq!(enqueued[0].1["unit"], serde_json::json!("msats"));

    fixture.processor.fail_create("provider unavailable");
    let failure = fixture
        .service
        .create_invoice(&testing::pubkey(1), 1_500, "admission")
        .await
        .expect_err("the processor failed");
    assert_eq!(
        failure.to_string(),
        "payment processor error: provider unavailable"
    );
    assert_eq!(fixture.outbox.enqueued().len(), 1, "no second outbox row");
}

#[tokio::test]
async fn confirm_invoice_guards_and_admits_at_the_enabled_fee_sum() {
    let payer = testing::pubkey(1);
    let fixture = build(
        payments_settings(vec![
            fee(1_000, true, Vec::new()),
            fee(500, true, Vec::new()),
            fee(10_000, false, Vec::new()),
            fee(9_000, true, vec![SettingsPubkey(payer.to_string())]),
        ]),
        false,
    );

    let mut missing_confirmed = invoice(InvoiceUnit::Sats, Some(2));
    missing_confirmed.confirmed_at = None;
    assert_eq!(
        fixture
            .service
            .confirm_invoice(&missing_confirmed)
            .await
            .expect_err("no confirmation date")
            .to_string(),
        "payment processor error: Invoice confirmation date is not set"
    );

    let mut pending = invoice(InvoiceUnit::Sats, Some(2));
    pending.status = InvoiceStatus::Pending;
    assert_eq!(
        fixture
            .service
            .confirm_invoice(&pending)
            .await
            .expect_err("not complete")
            .to_string(),
        "payment processor error: Invoice is not complete: pending"
    );

    let missing_amount = invoice(InvoiceUnit::Sats, None);
    assert_eq!(
        fixture
            .service
            .confirm_invoice(&missing_amount)
            .await
            .expect_err("no paid amount")
            .to_string(),
        "payment processor error: Invoice paid amount is not set: undefined"
    );

    // 2 sats is 2 000 msats, which reaches the 1 500 msat sum of the enabled schedules.
    fixture
        .service
        .confirm_invoice(&invoice(InvoiceUnit::Sats, Some(2)))
        .await
        .expect("confirmed");
    assert_eq!(fixture.users.admitted().len(), 1);
    assert_eq!(fixture.invoices.confirmations().len(), 1);
    assert_eq!(fixture.invoices.confirmations()[0].1, 2);

    let enqueued = fixture.outbox.enqueued();
    assert_eq!(enqueued.last().expect("a row").0, "admission.invoice.paid");
    assert_eq!(
        enqueued.last().expect("a row").1["amountPaid"],
        serde_json::json!("2")
    );
    assert!(
        enqueued.last().expect("a row").1["confirmedAt"]
            .as_str()
            .expect("a string")
            .ends_with('Z')
    );

    // Below the sum: 1 sat is 1 000 msats.
    fixture
        .service
        .confirm_invoice(&invoice(InvoiceUnit::Sats, Some(1)))
        .await
        .expect("confirmed");
    assert_eq!(
        fixture.users.admitted().len(),
        1,
        "no admission below the sum"
    );

    // A payer named in every enabled schedule's whitelist owes nothing.
    let whitelisted = fixture_with_only_whitelisted(&payer);
    whitelisted
        .service
        .confirm_invoice(&invoice(InvoiceUnit::Sats, Some(2)))
        .await
        .expect("confirmed");
    assert!(whitelisted.users.admitted().is_empty());
}

fn fixture_with_only_whitelisted(payer: &nostream_core::Pubkey) -> Fixture {
    build(
        payments_settings(vec![fee(
            1_000,
            true,
            vec![SettingsPubkey(payer.to_string())],
        )]),
        false,
    )
}

#[tokio::test]
async fn the_update_notifications_carry_the_capture_content_and_expiration() {
    let fixture = build(payments_settings(Vec::new()), true);
    let mut receiver = fixture.hub.subscribe();

    // A December reading: the expiration rolls into January of the next year.
    fixture.clock.set(
        chrono::DateTime::from_timestamp(1_798_000_000, 0)
            .expect("a date")
            .timestamp_millis() as u64,
    );

    fixture
        .service
        .send_invoice_update_notification(&invoice(InvoiceUnit::Msats, Some(1_500)))
        .await
        .expect("published");

    let event = fixture.events.creates().remove(0).event;
    assert_eq!(event.kind, Kind(402));
    assert_eq!(event.content, "Invoice paid: 1 sats");
    assert_eq!(event.tags[0][0], "p");
    assert_eq!(event.tags[1][0], "invoice");
    assert_eq!(event.tags[1][1], "lnbc1");
    assert_eq!(event.tags[2][0], "expiration");

    let expiration: i64 = event.tags[2][1].parse().expect("seconds");
    let expected = local_next_month_midnight(fixture.clock.now_secs());
    assert_eq!(
        expiration, expected,
        "local midnight of the same day next month"
    );

    let broadcast = tokio::time::timeout(std::time::Duration::from_millis(100), receiver.recv())
        .await
        .expect("the event is broadcast")
        .expect("a receiver");
    assert_eq!(broadcast.id, event.id);

    let missing_amount = fixture
        .service
        .send_invoice_update_notification(&invoice(InvoiceUnit::Msats, None))
        .await
        .expect_err("no paid amount");
    assert_eq!(
        missing_amount.to_string(),
        "payment processor error: Unable to notify user 0101010101010101010101010101010101010101010101010101010101010101 for invoice invoice-1"
    );

    // With no relay key the call still returns Ok and stores nothing.
    let without_key = build(payments_settings(Vec::new()), false);
    without_key
        .service
        .send_invoice_update_notification(&invoice(InvoiceUnit::Msats, Some(1_500)))
        .await
        .expect("a signing failure is logged, not returned");
    assert!(without_key.events.creates().is_empty());
}

fn local_next_month_midnight(now_secs: i64) -> i64 {
    let local = DateTime::from_timestamp(now_secs, 0)
        .expect("a date")
        .with_timezone(&Local);
    let (year, month) = if local.month() == 12 {
        (local.year() + 1, 1)
    } else {
        (local.year(), local.month() + 1)
    };

    Local
        .with_ymd_and_hms(year, month, local.day(), 0, 0, 0)
        .earliest()
        .expect("a local midnight")
        .timestamp()
}

#[tokio::test]
async fn the_renewal_notifications_use_amount_requested_and_the_invoice_expiry() {
    let fixture = build(payments_settings(Vec::new()), true);
    let mut stale = invoice(InvoiceUnit::Sats, None);
    stale.amount_requested = 21;

    fixture
        .service
        .send_renewal_notification(&stale)
        .await
        .expect("published");

    let event = fixture.events.creates().remove(0).event;
    assert_eq!(event.content, "Subscription renewal due: 21 sats");
    assert_eq!(
        event.tags[2][1], "1700100000",
        "the invoice's own expiry is the expiration tag"
    );
}
