//! The payment processors: resolution, the six providers' request and status shapes, and the
//! null processor.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use nostream_config::settings::{
    FeeSchedules, LnbitsPaymentsProcessor, LnurlPaymentsProcessor, NodelessPaymentsProcessor,
    NwcPaymentsProcessor, OpennodePaymentsProcessor, Payments, PaymentsProcessors, Processor,
    Settings, ZebedeePaymentsProcessor,
};
use nostream_services::error::ServicesError;
use nostream_services::payments::{
    InvoiceUpdate, Nip47Request, Nip47Response, Nip47Transport, NwcProcessor, PaymentProcessor,
    ProcessorInvoice, resolve_with_env,
};
use nostream_services::testing;
use nostream_storage::repositories::{Invoice, InvoiceStatus, InvoiceUnit};

fn payments(processor: Processor) -> Payments {
    Payments {
        enabled: true,
        processor,
        fee_schedules: FeeSchedules {
            admission: Vec::new(),
            publication: None,
        },
        invoice_expiry_seconds: None,
        subscription_plans: None,
    }
}

fn settings(processor: Processor, processors: PaymentsProcessors) -> Settings {
    let mut settings = testing::settings();
    settings.payments = Some(payments(processor));
    settings.payments_processors = Some(processors);

    settings
}

fn resolve(
    settings: &Settings,
    http: &Arc<testing::RecordingHttpClient>,
    env: &HashMap<String, String>,
) -> Result<Box<dyn PaymentProcessor>, ServicesError> {
    resolve_with_env(
        settings,
        Arc::clone(http) as Arc<dyn nostream_services::HttpClient>,
        &|name: &str| env.get(name).cloned(),
    )
}

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect()
}

/// The value a recorded call sent for `name`, when it sent one.
fn header<'a>(call: &'a testing::HttpCall, name: &str) -> Option<&'a str> {
    call.headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

fn zebedee_settings() -> PaymentsProcessors {
    PaymentsProcessors {
        zebedee: Some(ZebedeePaymentsProcessor {
            base_url: "https://api.zebedee.io".to_owned(),
            callback_base_url: "https://relay.example.com/callbacks/zebedee".to_owned(),
            ip_whitelist: vec!["127.0.0.1".to_owned()],
        }),
        ..Default::default()
    }
}

fn lnbits_settings() -> PaymentsProcessors {
    PaymentsProcessors {
        lnbits: Some(LnbitsPaymentsProcessor {
            base_url: "https://lnbits.example.com".to_owned(),
            callback_base_url: "https://relay.example.com/callbacks/lnbits".to_owned(),
        }),
        ..Default::default()
    }
}

fn nodeless_settings() -> PaymentsProcessors {
    PaymentsProcessors {
        nodeless: Some(NodelessPaymentsProcessor {
            base_url: "https://api.nodeless.io".to_owned(),
            store_id: "store-1".to_owned(),
        }),
        ..Default::default()
    }
}

fn opennode_settings() -> PaymentsProcessors {
    PaymentsProcessors {
        opennode: Some(OpennodePaymentsProcessor {
            base_url: "https://api.opennode.com".to_owned(),
            callback_base_url: "https://relay.example.com/callbacks/opennode".to_owned(),
        }),
        ..Default::default()
    }
}

fn lnurl_settings() -> PaymentsProcessors {
    PaymentsProcessors {
        lnurl: Some(LnurlPaymentsProcessor {
            invoice_url: "https://lnurl.example.com/pay".to_owned(),
        }),
        ..Default::default()
    }
}

fn configuration_message(result: Result<Box<dyn PaymentProcessor>, ServicesError>) -> String {
    match result {
        Err(ServicesError::Configuration(message)) => message,
        _ => panic!("expected a configuration error"),
    }
}

#[tokio::test]
async fn resolve_answers_the_null_processor_and_the_captures_failures() {
    let http = testing::RecordingHttpClient::new();

    let mut disabled = testing::settings();
    disabled.payments = None;
    assert_eq!(
        resolve(&disabled, &http, &HashMap::new())
            .expect("the null processor")
            .processor(),
        None
    );

    let mut off = testing::settings();
    let mut payments = payments(Processor::Lnurl);
    payments.enabled = false;
    off.payments = Some(payments);
    assert_eq!(
        resolve(&off, &http, &HashMap::new())
            .expect("the null processor")
            .processor(),
        None
    );

    let configured = settings(Processor::Zebedee, zebedee_settings());
    assert_eq!(
        resolve(&configured, &http, &env(&[("ZEBEDEE_API_KEY", "key")]))
            .expect("the zebedee processor")
            .processor(),
        Some(Processor::Zebedee)
    );

    assert_eq!(
        configuration_message(resolve(
            &settings(Processor::Zebedee, zebedee_settings()),
            &http,
            &HashMap::new()
        )),
        "ZEBEDEE_API_KEY must be set."
    );
    assert_eq!(
        configuration_message(resolve(
            &settings(Processor::Lnbits, lnbits_settings()),
            &http,
            &HashMap::new()
        )),
        "LNBITS_API_KEY must be set to an invoice or admin key."
    );
    assert_eq!(
        configuration_message(resolve(
            &settings(Processor::Nodeless, nodeless_settings()),
            &http,
            &HashMap::new()
        )),
        "NODELESS_API_KEY must be set."
    );
    assert_eq!(
        configuration_message(resolve(
            &settings(Processor::Opennode, opennode_settings()),
            &http,
            &HashMap::new()
        )),
        "OPENNODE_API_KEY must be set."
    );
    assert_eq!(
        configuration_message(resolve(
            &settings(Processor::Nwc, PaymentsProcessors::default()),
            &http,
            &HashMap::new()
        )),
        "NWC_URL must be set."
    );
    assert_eq!(
        configuration_message(resolve(
            &settings(Processor::Lnurl, PaymentsProcessors::default()),
            &http,
            &HashMap::new()
        )),
        "Unable to create payments processor: Setting paymentsProcessor.lnurl.invoiceURL is not configured."
    );

    let placeholder = PaymentsProcessors {
        zebedee: Some(ZebedeePaymentsProcessor {
            base_url: "https://api.zebedee.io".to_owned(),
            callback_base_url: "https://nostream.your-domain.com/callbacks/zebedee".to_owned(),
            ip_whitelist: vec!["127.0.0.1".to_owned()],
        }),
        ..Default::default()
    };
    assert_eq!(
        configuration_message(resolve(
            &settings(Processor::Zebedee, placeholder),
            &http,
            &env(&[("ZEBEDEE_API_KEY", "key")])
        )),
        "Setting paymentsProcessor.zebedee.callbackBaseURL is not configured."
    );

    let empty_whitelist = PaymentsProcessors {
        zebedee: Some(ZebedeePaymentsProcessor {
            base_url: "https://api.zebedee.io".to_owned(),
            callback_base_url: "https://relay.example.com/callbacks/zebedee".to_owned(),
            ip_whitelist: Vec::new(),
        }),
        ..Default::default()
    };
    assert_eq!(
        configuration_message(resolve(
            &settings(Processor::Zebedee, empty_whitelist),
            &http,
            &env(&[("ZEBEDEE_API_KEY", "key")])
        )),
        "Setting paymentsProcessor.zebedee.ipWhitelist is empty."
    );

    let nwc = PaymentsProcessors {
        nwc: Some(NwcPaymentsProcessor {
            invoice_expiry_seconds: 3_600,
            reply_timeout_ms: 5_000,
        }),
        ..Default::default()
    };
    assert_eq!(
        configuration_message(resolve(
            &settings(Processor::Nwc, nwc.clone()),
            &http,
            &env(&[("NWC_URL", "https://not-a-wallet.example.com")])
        )),
        "NWC_URL must be a valid nostr+walletconnect:// or nostrwalletconnect:// URI."
    );
}

#[tokio::test]
async fn zebedee_creates_and_decodes_its_invoice() {
    let http = testing::RecordingHttpClient::new();
    let processor = resolve(
        &settings(Processor::Zebedee, zebedee_settings()),
        &http,
        &env(&[("ZEBEDEE_API_KEY", "key")]),
    )
    .expect("the processor");

    http.respond(
        200,
        r#"{"data":{"id":"charge-1","internalId":"requester","invoice":{"request":"lnbc1"},"amount":"1500","description":"admission","unit":"msats","status":"pending","createdAt":"2026-01-02T03:04:05Z"}}"#,
    );

    let created = processor
        .create_invoice(1_500, "admission", "requester")
        .await
        .expect("created");
    let call = http.last_call().expect("a call");
    assert_eq!(call.url, "https://api.zebedee.io/v0/charges");
    let body: serde_json::Value =
        serde_json::from_str(call.body.as_deref().expect("body")).expect("json");
    assert_eq!(body["amount"], serde_json::json!("1500"));
    assert_eq!(body["internalId"], serde_json::json!("requester"));
    assert_eq!(body["description"], serde_json::json!("admission"));
    assert_eq!(
        body["callbackUrl"],
        serde_json::json!("https://relay.example.com/callbacks/zebedee")
    );
    assert_eq!(
        header(&call, "apikey"),
        Some("key"),
        "the create is authenticated"
    );
    assert_eq!(created.id, "charge-1");
    assert_eq!(created.pubkey.as_deref(), Some("requester"));
    assert_eq!(created.bolt11, "lnbc1");
    assert_eq!(created.amount_requested, 1_500);
    assert_eq!(created.unit, InvoiceUnit::Msats);
    assert_eq!(created.status, InvoiceStatus::Pending);

    http.respond(
        200,
        r#"{"data":{"id":"charge-1","internalId":"requester","invoice":{"request":"lnbc1"},"amount":"2000","description":"admission","unit":"msats","status":"completed","createdAt":"2026-01-02T03:04:05Z","confirmedAt":"2026-01-02T03:05:00Z"}}"#,
    );

    let update = processor
        .get_invoice(&invoice("charge-1"))
        .await
        .expect("lookup");
    let lookup = http.last_call().expect("a call");
    assert_eq!(
        header(&lookup, "apikey"),
        Some("key"),
        "the lookup is authenticated"
    );
    assert_eq!(update.id.as_deref(), Some("charge-1"));
    assert_eq!(update.amount_requested, Some(2_000));
    assert_eq!(update.status, Some(InvoiceStatus::Completed));
    assert!(update.confirmed_at.is_some());
    assert_eq!(
        update.expires_at, None,
        "an absent expiresAt decodes to None"
    );
}

fn invoice(id: &str) -> Invoice {
    Invoice {
        id: id.to_owned(),
        pubkey: testing::pubkey(1),
        bolt11: "lnbc1".to_owned(),
        amount_requested: 1_500,
        amount_paid: None,
        unit: InvoiceUnit::Msats,
        status: InvoiceStatus::Pending,
        description: "admission".to_owned(),
        confirmed_at: None,
        expires_at: Some(chrono::Utc::now()),
        updated_at: chrono::Utc::now(),
        created_at: chrono::Utc::now(),
        verify_url: Some("https://lnurl.example.com/verify/1".to_owned()),
    }
}

#[tokio::test]
async fn lnurl_creates_a_uuid_invoice_and_reads_back_settlement() {
    let http = testing::RecordingHttpClient::new();
    let processor = resolve(
        &settings(Processor::Lnurl, lnurl_settings()),
        &http,
        &HashMap::new(),
    )
    .expect("the processor");

    http.respond(
        200,
        r#"{"pr":"lnbc1","verify":"https://lnurl.example.com/verify/1"}"#,
    );

    let created = processor
        .create_invoice(1_500, "admission", "requester")
        .await
        .expect("created");
    let call = http.last_call().expect("a call");
    assert_eq!(
        call.url,
        "https://lnurl.example.com/pay/callback?amount=1500&comment=admission"
    );
    assert_eq!(created.unit, InvoiceUnit::Msats);
    assert_eq!(created.status, InvoiceStatus::Pending);
    assert_eq!(
        created.verify_url.as_deref(),
        Some("https://lnurl.example.com/verify/1")
    );
    assert_eq!(created.expires_at, None);
    assert_eq!(created.id.len(), 36);
    assert_eq!(&created.id[14..15], "4", "a version-4 UUID");

    http.respond(200, r#"{"settled":true}"#);
    let update = processor.get_invoice(&invoice("id")).await.expect("lookup");
    assert_eq!(update.status, Some(InvoiceStatus::Completed));
    assert!(update.confirmed_at.is_some());
}

#[tokio::test]
async fn lnbits_sends_sats_and_an_hmac_then_decodes_both_timestamp_shapes() {
    let http = testing::RecordingHttpClient::new();
    let processor = resolve(
        &settings(Processor::Lnbits, lnbits_settings()),
        &http,
        &env(&[("LNBITS_API_KEY", "key"), ("SECRET", "secret")]),
    )
    .expect("the processor");

    http.respond(200, r#"{"payment_hash":"ph1"}"#);
    http.respond(
        200,
        r#"{"paid":false,"details":{"payment_hash":"ph1","bolt11":"lnbc1","amount":1500,"extra":{"internalId":"requester"},"memo":"admission","expiry":4102444800,"time":1700000000}}"#,
    );

    let created = processor
        .create_invoice(1_500, "admission", "requester")
        .await
        .expect("created");
    let call = http.last_call().expect("a call");
    assert_eq!(call.url, "https://lnbits.example.com/api/v1/payments/ph1");
    assert_eq!(
        header(&call, "x-api-key"),
        Some("key"),
        "the lookup is authenticated"
    );
    let _ = call;

    let first = http.calls().into_iter().next().expect("the POST");
    assert_eq!(first.url, "https://lnbits.example.com/api/v1/payments");
    assert_eq!(
        header(&first, "x-api-key"),
        Some("key"),
        "the create is authenticated"
    );
    let body: serde_json::Value =
        serde_json::from_str(first.body.as_deref().expect("body")).expect("json");
    assert_eq!(body["amount"], serde_json::json!(1), "1500 msats is 1 sat");
    assert_eq!(body["memo"], serde_json::json!("admission"));
    assert_eq!(body["extra"]["internalId"], serde_json::json!("requester"));
    assert_eq!(body["out"], serde_json::json!(false));
    let webhook = body["webhook"].as_str().expect("webhook");
    assert!(webhook.contains("hmac="));
    let hmac = webhook.split("hmac=").nth(1).expect("the hmac");
    let decoded = hmac.replace("%3A", ":");
    let (expiry, digest) = decoded.split_once(':').expect("expiry:digest");
    assert!(expiry.parse::<i64>().is_ok());
    assert_eq!(digest.len(), 64);
    assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));

    assert_eq!(created.amount_requested, 1);
    assert_eq!(created.unit, InvoiceUnit::Sats);

    // A paid lookup with unix seconds.
    http.respond(
        200,
        r#"{"paid":true,"details":{"payment_hash":"ph1","bolt11":"lnbc1","amount":1500,"extra":{"internalId":"requester"},"memo":"admission","expiry":4102444800,"time":1700000000}}"#,
    );
    let paid = processor
        .get_invoice(&invoice("ph1"))
        .await
        .expect("lookup");
    assert_eq!(paid.status, Some(InvoiceStatus::Completed));
    assert!(paid.expires_at.is_some());

    // An unpaid lookup whose expiry is an ISO string in the future.
    http.respond(
        200,
        r#"{"paid":false,"details":{"payment_hash":"ph1","bolt11":"lnbc1","amount":1500,"extra":{"internalId":"requester"},"memo":"admission","expiry":"2100-01-01T00:00:00+00:00","time":"2023-11-14T22:13:20+00:00"}}"#,
    );
    let pending = processor
        .get_invoice(&invoice("ph1"))
        .await
        .expect("lookup");
    assert_eq!(pending.status, Some(InvoiceStatus::Pending));

    // An unpaid lookup past its expiry.
    http.respond(
        200,
        r#"{"paid":false,"details":{"payment_hash":"ph1","bolt11":"lnbc1","amount":1500,"extra":{"internalId":"requester"},"memo":"admission","expiry":"2020-01-01T00:00:00+00:00","time":"2019-11-14T22:13:20+00:00"}}"#,
    );
    let expired = processor
        .get_invoice(&invoice("ph1"))
        .await
        .expect("lookup");
    assert_eq!(expired.status, Some(InvoiceStatus::Expired));
}

#[tokio::test]
async fn nodeless_maps_every_status_and_defaults_its_expiry() {
    let http = testing::RecordingHttpClient::new();
    let processor = resolve(
        &settings(Processor::Nodeless, nodeless_settings()),
        &http,
        &env(&[("NODELESS_API_KEY", "key")]),
    )
    .expect("the processor");

    http.respond(
        200,
        r#"{"data":{"id":"inv1","metadata":{"requestId":"requester","description":"admission","unit":"sats"},"lightningInvoice":"lnbc1","satsAmount":2,"status":"new","createdAt":"2026-01-02T03:04:05Z"}}"#,
    );
    let created = processor
        .create_invoice(1_500, "admission", "requester")
        .await
        .expect("created");
    let first = http.calls().into_iter().next().expect("the POST");
    assert_eq!(
        first.url,
        "https://api.nodeless.io/api/v1/store/store-1/invoice"
    );
    assert_eq!(header(&first, "authorization"), Some("Bearer key"));
    assert_eq!(header(&first, "accept"), Some("application/json"));
    let body: serde_json::Value =
        serde_json::from_str(first.body.as_deref().expect("body")).expect("json");
    assert_eq!(body["currency"], serde_json::json!("SATS"));
    assert_eq!(body["metadata"]["unit"], serde_json::json!("sats"));
    assert_eq!(body["amount"], serde_json::json!(1));
    assert_eq!(created.amount_requested, 2);
    assert_eq!(
        created.expires_at,
        created
            .created_at
            .map(|created| created + chrono::TimeDelta::minutes(15))
    );

    for (provider, expected) in [
        ("new", InvoiceStatus::Pending),
        ("pending_confirmation", InvoiceStatus::Pending),
        ("underpaid", InvoiceStatus::Pending),
        ("in_flight", InvoiceStatus::Pending),
        ("paid", InvoiceStatus::Completed),
        ("overpaid", InvoiceStatus::Completed),
        ("expired", InvoiceStatus::Expired),
    ] {
        http.respond(
            200,
            format!(
                r#"{{"data":{{"id":"inv1","metadata":{{"requestId":"requester","description":"admission","unit":"sats"}},"lightningInvoice":"lnbc1","satsAmount":2,"status":"{provider}","createdAt":"2026-01-02T03:04:05Z"}}}}"#
            ),
        );
        let update = processor
            .get_invoice(&invoice("inv1"))
            .await
            .expect("lookup");
        assert_eq!(update.status, Some(expected), "provider status {provider}");
    }

    let lookup = http.last_call().expect("a call");
    assert_eq!(header(&lookup, "authorization"), Some("Bearer key"));
}

#[tokio::test]
async fn opennode_maps_every_status_and_both_payreq_shapes() {
    let http = testing::RecordingHttpClient::new();
    let processor = resolve(
        &settings(Processor::Opennode, opennode_settings()),
        &http,
        &env(&[("OPENNODE_API_KEY", "key")]),
    )
    .expect("the processor");

    http.respond(
        200,
        r#"{"data":{"id":"ch1","order_id":"requester","description":"admission","amount":1,"status":"unpaid","created_at":1700000000,"lightning_invoice":{"payreq":"lnbc1","expires_at":4102444800}}}"#,
    );
    let created = processor
        .create_invoice(1_500, "admission", "requester")
        .await
        .expect("created");
    let first = http.calls().into_iter().next().expect("the POST");
    assert_eq!(first.url, "https://api.opennode.com/v1/charges");
    assert_eq!(
        header(&first, "authorization"),
        Some("key"),
        "the create is authenticated"
    );
    let body: serde_json::Value =
        serde_json::from_str(first.body.as_deref().expect("body")).expect("json");
    assert_eq!(body["ttl"], serde_json::json!(10));
    assert_eq!(body["amount"], serde_json::json!(1));
    assert_eq!(body["order_id"], serde_json::json!("requester"));
    assert_eq!(created.bolt11, "lnbc1");
    assert!(created.expires_at.is_some());

    for (provider, expected) in [
        ("expired", InvoiceStatus::Expired),
        ("refunded", InvoiceStatus::Expired),
        ("unpaid", InvoiceStatus::Pending),
        ("processing", InvoiceStatus::Pending),
        ("underpaid", InvoiceStatus::Pending),
        ("paid", InvoiceStatus::Completed),
    ] {
        http.respond(
            200,
            format!(
                r#"{{"data":{{"id":"ch1","order_id":"requester","description":"admission","amount":1,"status":"{provider}","created_at":1700000000,"lightning":{{"payreq":"lnbc2","expires_at":"2100-01-01T00:00:00Z"}}}}}}"#
            ),
        );
        let update = processor
            .get_invoice(&invoice("ch1"))
            .await
            .expect("lookup");
        assert_eq!(update.status, Some(expected), "provider status {provider}");
        assert_eq!(update.bolt11.as_deref(), Some("lnbc2"));
    }

    http.respond(
        200,
        r#"{"data":{"id":"ch1","order_id":"requester","description":"admission","price":3,"status":"paid","created_at":1700000000,"lightning_invoice":{"payreq":"lnbc3","expires_at":4102444800}}}"#,
    );
    let update = processor
        .get_invoice(&invoice("ch1"))
        .await
        .expect("lookup");
    assert_eq!(
        update.amount_requested,
        Some(3),
        "the amount falls back to price"
    );
    let lookup = http.last_call().expect("a call");
    assert_eq!(
        header(&lookup, "authorization"),
        Some("key"),
        "the lookup is authenticated"
    );
}

#[derive(Debug, Default)]
struct FakeTransport {
    requests: std::sync::Mutex<Vec<Nip47Request>>,
    replies: std::sync::Mutex<Vec<(Duration, Result<Nip47Response, String>)>>,
}

impl FakeTransport {
    fn reply(&self, result: serde_json::Value) {
        self.replies
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((Duration::ZERO, Ok(Nip47Response { result })));
    }

    fn delay(&self, delay: Duration, result: serde_json::Value) {
        self.replies
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((delay, Ok(Nip47Response { result })));
    }

    fn requests(&self) -> Vec<Nip47Request> {
        self.requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl Nip47Transport for FakeTransport {
    fn request<'a>(
        &'a self,
        request: &'a Nip47Request,
    ) -> Pin<Box<dyn Future<Output = Result<Nip47Response, ServicesError>> + Send + 'a>> {
        Box::pin(async move {
            self.requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(request.clone());

            let (delay, reply) = self
                .replies
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(0);
            tokio::time::sleep(delay).await;

            reply.map_err(ServicesError::Payment)
        })
    }
}

#[tokio::test]
async fn nwc_sends_the_captures_requests_maps_states_and_times_out() {
    let transport = Arc::new(FakeTransport::default());
    let transport_trait: Arc<dyn Nip47Transport> =
        Arc::clone(&transport) as Arc<dyn Nip47Transport>;
    let processor = NwcProcessor::with_transport(transport_trait, Duration::from_millis(40), 3_600);

    transport.reply(serde_json::json!({
        "payment_hash": "hash-1",
        "invoice": "lnbc1",
        "amount": 1500,
        "description": "admission",
        "state": "pending",
        "created_at": 1_700_000_000,
        "expires_at": 1_700_003_600,
    }));

    let created = processor
        .create_invoice(1_500, "admission", "requester")
        .await
        .expect("created");
    let request = transport.requests().remove(0);
    assert_eq!(request.method, "make_invoice");
    assert_eq!(request.params["amount"], serde_json::json!(1500));
    assert_eq!(request.params["expiry"], serde_json::json!(3_600));
    assert_eq!(created.id, "hash-1");
    assert_eq!(created.unit, InvoiceUnit::Msats);
    assert_eq!(created.status, InvoiceStatus::Pending);

    for (state, expected) in [
        (serde_json::Value::Null, InvoiceStatus::Pending),
        (serde_json::json!("accepted"), InvoiceStatus::Pending),
        (serde_json::json!("pending"), InvoiceStatus::Pending),
        (serde_json::json!("settled"), InvoiceStatus::Completed),
        (serde_json::json!("expired"), InvoiceStatus::Expired),
        (serde_json::json!("failed"), InvoiceStatus::Expired),
    ] {
        let mut result = serde_json::json!({ "payment_hash": "hash-1" });
        if !state.is_null() {
            result["state"] = state.clone();
        }
        transport.reply(result);

        let update = processor
            .get_invoice(&invoice("hash-1"))
            .await
            .expect("lookup");
        assert_eq!(update.status, Some(expected), "state {state}");
    }

    let lookup = transport.requests().into_iter().last().expect("a request");
    assert_eq!(lookup.method, "lookup_invoice");
    assert_eq!(lookup.params["payment_hash"], serde_json::json!("hash-1"));

    transport.delay(Duration::from_millis(200), serde_json::json!({}));
    let failure = processor
        .get_invoice(&invoice("hash-1"))
        .await
        .expect_err("the reply is late");
    assert_eq!(
        failure.to_string(),
        "payment processor error: reply timeout after 40ms"
    );

    let too_large = processor
        .create_invoice(i64::MAX, "admission", "requester")
        .await
        .expect_err("not a safe integer");
    assert_eq!(
        too_large.to_string(),
        "payment processor error: CreateInvoiceRequest.amount exceeds Number.MAX_SAFE_INTEGER."
    );
}

#[tokio::test]
async fn the_null_processor_returns_empty_pending_invoices() {
    let http = testing::RecordingHttpClient::new();
    let mut settings = testing::settings();
    settings.payments = None;
    let processor = resolve(&settings, &http, &HashMap::new()).expect("the null processor");

    let created: ProcessorInvoice = processor
        .create_invoice(1_500, "admission", "requester")
        .await
        .expect("created");
    assert_eq!(created.id, "");
    assert_eq!(created.bolt11, "");
    assert_eq!(created.status, InvoiceStatus::Pending);
    assert_eq!(created.unit, InvoiceUnit::Msats);
    assert_eq!(created.amount_requested, 0);

    let update: InvoiceUpdate = processor
        .get_invoice(&invoice("given"))
        .await
        .expect("lookup");
    assert_eq!(update.id.as_deref(), Some("given"));
    assert_eq!(update.status, Some(InvoiceStatus::Pending));
}
