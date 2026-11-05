//! Test support: in-memory repository doubles, a recording HTTP client and the seams a
//! service's tests drive.
//!
//! Compiled into the library (not `#[cfg(test)]`) because the integration tests and
//! `nostreamd`'s wiring test link the crate as a dependency and cannot see a test-only
//! module — the same reason `nostream_relay::testing` exists. No database, no network and
//! no Tor daemon is needed by anything here.

use std::collections::{HashMap, HashSet, VecDeque};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::stream;
use nostream_config::notifications::{
    AdminNotificationsSettings, OperatorNotificationChannelType, OperatorNotificationEventToggles,
    OperatorNotificationRetrySettings, OperatorNotificationTarget,
};
use nostream_config::settings::Settings;
use nostream_core::clock::Clock;
use nostream_core::nip05::{FetchOutcome, Nip05Fetch};
use nostream_core::{Event, EventId, Filter, Kind, Pubkey, Secret};
use nostream_storage::repositories::{
    DeliveryLogEntry, DeliveryLogFilters, DvmJob, DvmJobRepository, DvmJobStatus, DvmJobUpdate,
    EventPurgeCounts, EventRecord, EventRepository, EventRetentionOptions, FieldUpdate, Invoice,
    InvoiceRepository, InvoiceStatus, NewDeliveryLogEntry, Nip05Verification,
    Nip05VerificationRepository, NotificationDeliveryLogRepository, NotificationOutboxRepository,
    OutboxMessage, OutboxPayload, QueryStream, ReconciliationItem, StorageFuture, User, UserPatch,
    UserRepository,
};

use crate::error::ServicesError;
use crate::http::{HttpClient, HttpFuture, HttpResponse};
use crate::scheduler::WorkerSpec;

/// The relay's test settings document, which the services read the same way.
pub fn settings() -> Settings {
    nostream_relay::testing::settings()
}

/// A settings document with payments enabled and one admission fee.
pub fn payments_settings(processor: nostream_config::settings::Processor) -> Settings {
    let mut settings = settings();
    settings.payments = Some(nostream_config::settings::Payments {
        enabled: true,
        processor,
        fee_schedules: nostream_config::settings::FeeSchedules {
            admission: Vec::new(),
            publication: None,
        },
        invoice_expiry_seconds: None,
        subscription_plans: None,
    });

    settings
}

/// A call trace several doubles append to, so one test can assert an order that crosses
/// them (the capture's `createInvoice` sequence, for one).
#[derive(Debug, Default, Clone)]
pub struct Trace {
    entries: Arc<Mutex<Vec<String>>>,
}

impl Trace {
    /// An empty trace.
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends one entry.
    pub fn push(&self, entry: impl Into<String>) {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(entry.into());
    }

    /// Every entry, in order.
    pub fn entries(&self) -> Vec<String> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

/// One recorded HTTP call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpCall {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
enum HttpScript {
    Response {
        status: u16,
        body: String,
    },
    Failure {
        status: Option<u16>,
        message: String,
    },
}

/// An HTTP client that records every call and answers from a script.
#[derive(Debug, Default)]
pub struct RecordingHttpClient {
    calls: Mutex<Vec<HttpCall>>,
    script: Mutex<VecDeque<HttpScript>>,
}

impl RecordingHttpClient {
    /// A client with no scripted answer.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Scripts one successful response.
    pub fn respond(&self, status: u16, body: impl Into<String>) {
        self.script
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push_back(HttpScript::Response {
                status,
                body: body.into(),
            });
    }

    /// Scripts one transport failure, with the status when one arrived.
    pub fn fail(&self, status: Option<u16>, message: impl Into<String>) {
        self.script
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push_back(HttpScript::Failure {
                status,
                message: message.into(),
            });
    }

    /// Every call, in order.
    pub fn calls(&self) -> Vec<HttpCall> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The last call.
    pub fn last_call(&self) -> Option<HttpCall> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .last()
            .cloned()
    }

    fn next(&self, call: HttpCall) -> Result<HttpResponse, ServicesError> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(call);

        match self
            .script
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pop_front()
        {
            Some(HttpScript::Response { status, body }) if (200..300).contains(&status) => {
                Ok(HttpResponse { status, body })
            }
            Some(HttpScript::Response { status, .. }) => Err(ServicesError::Http {
                status: Some(status),
                message: format!("HTTP status {status}"),
            }),
            Some(HttpScript::Failure { status, message }) => {
                Err(ServicesError::Http { status, message })
            }
            None => Err(ServicesError::Http {
                status: None,
                message: "no scripted response".to_owned(),
            }),
        }
    }
}

impl HttpClient for RecordingHttpClient {
    fn get<'a>(
        &'a self,
        url: &'a str,
        headers: &'a [(String, String)],
        timeout: Duration,
    ) -> HttpFuture<'a> {
        Box::pin(async move {
            self.next(HttpCall {
                method: "GET",
                url: url.to_owned(),
                headers: headers.to_vec(),
                body: None,
                timeout,
            })
        })
    }

    fn post<'a>(
        &'a self,
        url: &'a str,
        headers: &'a [(String, String)],
        body: &'a str,
        timeout: Duration,
    ) -> HttpFuture<'a> {
        Box::pin(async move {
            self.next(HttpCall {
                method: "POST",
                url: url.to_owned(),
                headers: headers.to_vec(),
                body: Some(body.to_owned()),
                timeout,
            })
        })
    }
}

/// One scripted NIP-05 answer.
#[derive(Debug, Clone)]
pub struct Nip05Call {
    pub url: String,
    pub timeout_ms: u64,
    pub max_bytes: usize,
    pub max_redirects: usize,
}

/// A NIP-05 fetch seam with a script and a call log.
#[derive(Debug, Default)]
pub struct FakeNip05Fetch {
    calls: Mutex<Vec<Nip05Call>>,
    script: Mutex<VecDeque<Result<FetchOutcome, String>>>,
}

impl FakeNip05Fetch {
    /// A fetch with no scripted answer.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Scripts one answer.
    pub fn respond(&self, status: u16, body: impl Into<Vec<u8>>) {
        self.script
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push_back(Ok(FetchOutcome {
                status,
                body: body.into(),
            }));
    }

    /// Scripts one transport failure.
    pub fn fail(&self, reason: impl Into<String>) {
        self.script
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push_back(Err(reason.into()));
    }

    /// Every call, in order.
    pub fn calls(&self) -> Vec<Nip05Call> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl Nip05Fetch for FakeNip05Fetch {
    fn get<'a>(
        &'a self,
        url: &'a str,
        timeout_ms: u64,
        max_bytes: usize,
        max_redirects: usize,
    ) -> Pin<Box<dyn Future<Output = Result<FetchOutcome, nostream_core::CoreError>> + Send + 'a>>
    {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(Nip05Call {
                    url: url.to_owned(),
                    timeout_ms,
                    max_bytes,
                    max_redirects,
                });

            match self
                .script
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .pop_front()
            {
                Some(Ok(outcome)) => Ok(outcome),
                Some(Err(reason)) => Err(nostream_core::CoreError::Fetch(reason)),
                None => Err(nostream_core::CoreError::Fetch(
                    "no scripted response".to_owned(),
                )),
            }
        })
    }
}

/// An event repository holding its rows in memory.
#[derive(Debug, Default)]
pub struct InMemoryEventRepository {
    records: Mutex<Vec<EventRecord>>,
    creates: Mutex<Vec<EventRecord>>,
    create_many_calls: Mutex<Vec<Vec<EventRecord>>>,
    upsert_many_calls: Mutex<Vec<Vec<EventRecord>>>,
    deletes: Mutex<Vec<(Pubkey, Vec<EventId>)>>,
    reads: Mutex<u64>,
    purge_calls: Mutex<Vec<EventRetentionOptions>>,
    read_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
}

impl InMemoryEventRepository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// A store seeded with events.
    pub fn with_events(events: impl IntoIterator<Item = Event>) -> Arc<Self> {
        let store = Self::default();
        store
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .extend(
                events
                    .into_iter()
                    .map(|event| EventRecord::from_event(&event)),
            );

        Arc::new(store)
    }

    /// The stored events, in insertion order.
    pub fn events(&self) -> Vec<Event> {
        self.records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|record| record.event.clone())
            .collect()
    }

    /// Every `create` call's record.
    pub fn creates(&self) -> Vec<EventRecord> {
        self.creates
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every `create_many` batch.
    pub fn create_many_calls(&self) -> Vec<Vec<EventRecord>> {
        self.create_many_calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every `upsert_many` batch.
    pub fn upsert_many_calls(&self) -> Vec<Vec<EventRecord>> {
        self.upsert_many_calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every `delete_by_pubkey_and_ids` call.
    pub fn deletes(&self) -> Vec<(Pubkey, Vec<EventId>)> {
        self.deletes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// How many `find_by_filters` calls were made.
    pub fn reads(&self) -> u64 {
        *self
            .reads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Every retention call.
    pub fn purge_calls(&self) -> Vec<EventRetentionOptions> {
        self.purge_calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Makes every `find_by_filters` wait for one permit. Releases with
    /// `Semaphore::add_permits`.
    pub fn gate_reads(&self) -> Arc<tokio::sync::Semaphore> {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *self
            .read_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&gate));

        gate
    }
}

fn matches_filter(record: &EventRecord, filter: &Filter) -> bool {
    if let Some(ids) = &filter.ids
        && !ids.iter().any(|id| *id == record.event.id.to_string())
    {
        return false;
    }

    if let Some(kinds) = &filter.kinds
        && !kinds.contains(&record.event.kind)
    {
        return false;
    }

    if let Some(authors) = &filter.authors
        && !authors
            .iter()
            .any(|author| *author == record.event.pubkey.to_string())
    {
        return false;
    }

    true
}

impl EventRepository for InMemoryEventRepository {
    fn create<'a>(&'a self, record: &'a EventRecord) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            self.creates
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(record.clone());
            self.records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(record.clone());

            Ok(1)
        })
    }

    fn create_many<'a>(&'a self, records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            self.create_many_calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(records.to_vec());
            self.records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .extend(records.iter().cloned());

            Ok(records.len() as u64)
        })
    }

    fn upsert<'a>(&'a self, record: &'a EventRecord) -> StorageFuture<'a, u64> {
        self.create(record)
    }

    fn upsert_many<'a>(&'a self, records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            self.upsert_many_calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(records.to_vec());
            self.records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .extend(records.iter().cloned());

            Ok(records.len() as u64)
        })
    }

    fn find_by_filters<'a>(
        &'a self,
        filters: &'a [Filter],
    ) -> StorageFuture<'a, QueryStream<'a, EventRecord>> {
        Box::pin(async move {
            let gate = self
                .read_gate
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();

            if let Some(gate) = gate {
                let _permit = gate.acquire().await.map_err(|_| {
                    nostream_storage::StorageError::NotImplemented { module: "testing" }
                })?;
            }

            *self
                .reads
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) += 1;

            let records = self
                .records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();

            let mut selected: Vec<EventRecord> = records
                .into_iter()
                .filter(|record| filters.iter().any(|filter| matches_filter(record, filter)))
                .collect();

            // The repository orders newest first and honours the filter's limit; the wot
            // graph reads exactly one kind-3 event per author and takes the newest.
            selected.sort_by_key(|record| std::cmp::Reverse(record.event.created_at));

            if let Some(limit) = filters.iter().filter_map(|filter| filter.limit).max() {
                selected.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
            }

            let stream: QueryStream<'a, EventRecord> =
                Box::pin(stream::iter(selected.into_iter().map(Ok)));

            Ok(stream)
        })
    }

    fn count_by_filters<'a>(&'a self, _filters: &'a [Filter]) -> StorageFuture<'a, u64> {
        Box::pin(async { Ok(0) })
    }

    fn find_reconciliation_items<'a>(
        &'a self,
        _filter: &'a Filter,
    ) -> StorageFuture<'a, QueryStream<'a, ReconciliationItem>> {
        Box::pin(async {
            let stream: QueryStream<'a, ReconciliationItem> =
                Box::pin(stream::iter(Vec::new().into_iter().map(Ok)));

            Ok(stream)
        })
    }

    fn delete_by_pubkey_and_ids<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        ids: &'a [EventId],
    ) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            self.deletes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((*pubkey, ids.to_vec()));

            Ok(ids.len() as u64)
        })
    }

    fn delete_by_pubkey_except_kinds<'a>(
        &'a self,
        _pubkey: &'a Pubkey,
        _excluded_kinds: &'a [Kind],
    ) -> StorageFuture<'a, u64> {
        Box::pin(async { Ok(0) })
    }

    fn has_active_request_to_vanish<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async { Ok(false) })
    }

    fn delete_expired_and_retained<'a>(
        &'a self,
        options: &'a EventRetentionOptions,
    ) -> StorageFuture<'a, EventPurgeCounts> {
        Box::pin(async move {
            self.purge_calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(options.clone());

            Ok(EventPurgeCounts::default())
        })
    }
}

/// An invoice repository holding its rows in memory.
#[derive(Debug, Default)]
pub struct InMemoryInvoiceRepository {
    invoices: Mutex<Vec<Invoice>>,
    upserts: Mutex<Vec<Invoice>>,
    reads: Mutex<Vec<(u64, u64)>>,
    status_updates: Mutex<Vec<(String, InvoiceStatus)>>,
    confirmations: Mutex<Vec<(String, i64, DateTime<Utc>)>>,
    trace: Mutex<Option<Trace>>,
}

impl InMemoryInvoiceRepository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Seeds the pending list.
    pub fn set_invoices(&self, invoices: Vec<Invoice>) {
        *self
            .invoices
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = invoices;
    }

    /// Every `upsert` call.
    pub fn upserts(&self) -> Vec<Invoice> {
        self.upserts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The `(offset, limit)` of every page read.
    pub fn reads(&self) -> Vec<(u64, u64)> {
        self.reads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every status update.
    pub fn status_updates(&self) -> Vec<(String, InvoiceStatus)> {
        self.status_updates
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every confirmation.
    pub fn confirmations(&self) -> Vec<(String, i64, DateTime<Utc>)> {
        self.confirmations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Appends this store's calls to `trace`.
    pub fn set_trace(&self, trace: Trace) {
        *self
            .trace
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(trace);
    }
}

impl InvoiceRepository for InMemoryInvoiceRepository {
    fn find_by_id<'a>(&'a self, id: &'a str) -> StorageFuture<'a, Option<Invoice>> {
        Box::pin(async move {
            Ok(self
                .invoices
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .find(|invoice| invoice.id == id)
                .cloned())
        })
    }

    fn upsert<'a>(&'a self, invoice: &'a Invoice) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            if let Some(trace) = self
                .trace
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
            {
                trace.push("invoice.upsert");
            }

            self.upserts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(invoice.clone());
            self.invoices
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(invoice.clone());

            Ok(1)
        })
    }

    fn update_status<'a>(
        &'a self,
        id: &'a str,
        status: InvoiceStatus,
    ) -> StorageFuture<'a, Option<Invoice>> {
        Box::pin(async move {
            self.status_updates
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((id.to_owned(), status));

            let mut invoices = self
                .invoices
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            let invoice = invoices.iter_mut().find(|invoice| invoice.id == id);
            Ok(invoice.map(|invoice| {
                invoice.status = status;
                invoice.clone()
            }))
        })
    }

    fn confirm_invoice<'a>(
        &'a self,
        invoice_id: &'a str,
        amount_received: i64,
        confirmed_at: DateTime<Utc>,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            self.confirmations
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((invoice_id.to_owned(), amount_received, confirmed_at));

            Ok(())
        })
    }

    fn find_pending_invoices<'a>(
        &'a self,
        offset: u64,
        limit: u64,
    ) -> StorageFuture<'a, Vec<Invoice>> {
        Box::pin(async move {
            self.reads
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((offset, limit));

            let invoices = self
                .invoices
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            Ok(invoices
                .iter()
                .skip(offset as usize)
                .take(limit as usize)
                .cloned()
                .collect())
        })
    }
}

/// A user repository recording every write.
#[derive(Debug, Default)]
pub struct InMemoryUserRepository {
    upserts: Mutex<Vec<UserPatch>>,
    admitted: Mutex<Vec<(Pubkey, DateTime<Utc>)>>,
    trace: Mutex<Option<Trace>>,
}

impl InMemoryUserRepository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Every `upsert` call.
    pub fn upserts(&self) -> Vec<UserPatch> {
        self.upserts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every `admit_user` call.
    pub fn admitted(&self) -> Vec<(Pubkey, DateTime<Utc>)> {
        self.admitted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Appends this store's calls to `trace`.
    pub fn set_trace(&self, trace: Trace) {
        *self
            .trace
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(trace);
    }
}

impl UserRepository for InMemoryUserRepository {
    fn find_by_pubkey<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, Option<User>> {
        Box::pin(async { Ok(None) })
    }

    fn upsert<'a>(&'a self, user: &'a UserPatch) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            if let Some(trace) = self
                .trace
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
            {
                trace.push("user.upsert");
            }

            self.upserts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(user.clone());

            Ok(1)
        })
    }

    fn get_balance_by_pubkey<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, i64> {
        Box::pin(async { Ok(0) })
    }

    fn is_vanished<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async { Ok(false) })
    }

    fn set_vanished<'a>(&'a self, _pubkey: &'a Pubkey, _vanished: bool) -> StorageFuture<'a, u64> {
        Box::pin(async { Ok(0) })
    }

    fn admit_user<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        admitted_at: DateTime<Utc>,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            if let Some(trace) = self
                .trace
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
            {
                trace.push("user.admit");
            }

            self.admitted
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((*pubkey, admitted_at));

            Ok(())
        })
    }

    fn revoke_admission<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, u64> {
        Box::pin(async { Ok(0) })
    }
}

/// One `mark_failed` call: `(outbox id, error, attempt count, max attempts, base delay ms)`.
pub type FailedOutboxCall = (String, String, i32, i32, i64);

/// An outbox repository recording the walk.
#[derive(Debug, Default)]
pub struct InMemoryOutboxRepository {
    enqueued: Mutex<Vec<(String, OutboxPayload)>>,
    claim: Mutex<Vec<OutboxMessage>>,
    claim_limits: Mutex<Vec<u64>>,
    delivered: Mutex<Vec<String>>,
    failed: Mutex<Vec<FailedOutboxCall>>,
    terminal_cutoffs: Mutex<Vec<DateTime<Utc>>>,
    trace: Mutex<Option<Trace>>,
}

impl InMemoryOutboxRepository {
    /// An empty outbox.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The messages the next `claim_batch` returns.
    pub fn set_claim(&self, messages: Vec<OutboxMessage>) {
        *self
            .claim
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = messages;
    }

    /// Every enqueued `(event type, payload)`.
    pub fn enqueued(&self) -> Vec<(String, OutboxPayload)> {
        self.enqueued
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every `claim_batch` limit.
    pub fn claim_limits(&self) -> Vec<u64> {
        self.claim_limits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every `mark_delivered` id.
    pub fn delivered(&self) -> Vec<String> {
        self.delivered
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every `mark_failed` call.
    pub fn failed(&self) -> Vec<FailedOutboxCall> {
        self.failed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every terminal-prune cutoff.
    pub fn terminal_cutoffs(&self) -> Vec<DateTime<Utc>> {
        self.terminal_cutoffs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Appends this store's calls to `trace`.
    pub fn set_trace(&self, trace: Trace) {
        *self
            .trace
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(trace);
    }
}

impl NotificationOutboxRepository for InMemoryOutboxRepository {
    fn enqueue<'a>(
        &'a self,
        event_type: &'a str,
        payload: &'a OutboxPayload,
    ) -> StorageFuture<'a, OutboxMessage> {
        Box::pin(async move {
            if let Some(trace) = self
                .trace
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
            {
                trace.push("outbox.enqueue");
            }

            self.enqueued
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((event_type.to_owned(), payload.clone()));

            let now = Utc::now();

            Ok(OutboxMessage {
                id: format!("outbox-{}", event_type),
                event_type: event_type.to_owned(),
                payload: payload.clone(),
                status: nostream_storage::repositories::OutboxStatus::Pending,
                attempt_count: 0,
                available_at: now,
                last_error: None,
                delivered_at: None,
                created_at: now,
                updated_at: now,
            })
        })
    }

    fn claim_batch<'a>(&'a self, limit: u64) -> StorageFuture<'a, Vec<OutboxMessage>> {
        Box::pin(async move {
            self.claim_limits
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(limit);

            let messages = self
                .claim
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .take(limit as usize)
                .cloned()
                .collect();

            Ok(messages)
        })
    }

    fn mark_delivered<'a>(&'a self, id: &'a str) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            self.delivered
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(id.to_owned());

            Ok(())
        })
    }

    fn mark_failed<'a>(
        &'a self,
        id: &'a str,
        error: &'a str,
        attempt_count: i32,
        max_attempts: i32,
        base_delay_ms: i64,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            self.failed
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((
                    id.to_owned(),
                    error.to_owned(),
                    attempt_count,
                    max_attempts,
                    base_delay_ms,
                ));

            Ok(())
        })
    }

    fn delete_terminal_older_than<'a>(&'a self, cutoff: DateTime<Utc>) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            self.terminal_cutoffs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(cutoff);

            Ok(0)
        })
    }
}

/// A delivery-log repository recording every row.
#[derive(Debug, Default)]
pub struct InMemoryDeliveryLogRepository {
    appended: Mutex<Vec<NewDeliveryLogEntry>>,
    successful: Mutex<HashMap<String, Vec<String>>>,
    cutoffs: Mutex<Vec<DateTime<Utc>>>,
}

impl InMemoryDeliveryLogRepository {
    /// An empty log.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Makes `find_successful_target_ids` answer these ids for `outbox_id`.
    pub fn set_successful(&self, outbox_id: &str, targets: Vec<String>) {
        self.successful
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(outbox_id.to_owned(), targets);
    }

    /// Every appended row.
    pub fn appended(&self) -> Vec<NewDeliveryLogEntry> {
        self.appended
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every prune cutoff.
    pub fn cutoffs(&self) -> Vec<DateTime<Utc>> {
        self.cutoffs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl NotificationDeliveryLogRepository for InMemoryDeliveryLogRepository {
    fn append<'a>(&'a self, entry: &'a NewDeliveryLogEntry) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            self.appended
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(entry.clone());

            Ok(())
        })
    }

    fn find_recent<'a>(
        &'a self,
        _limit: u64,
        _filters: &'a DeliveryLogFilters,
    ) -> StorageFuture<'a, Vec<DeliveryLogEntry>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn find_successful_target_ids<'a>(
        &'a self,
        outbox_id: &'a str,
    ) -> StorageFuture<'a, Vec<String>> {
        Box::pin(async move {
            Ok(self
                .successful
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(outbox_id)
                .cloned()
                .unwrap_or_default())
        })
    }

    fn delete_older_than<'a>(&'a self, cutoff: DateTime<Utc>) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            self.cutoffs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(cutoff);

            Ok(0)
        })
    }
}

/// A DVM job repository holding its rows in memory.
#[derive(Debug, Default)]
pub struct InMemoryDvmJobRepository {
    jobs: Mutex<Vec<DvmJob>>,
    pending_calls: Mutex<Vec<(u64, Option<Vec<Kind>>)>>,
    assigned: Mutex<Vec<(EventId, i32)>>,
    updates: Mutex<Vec<DvmJobUpdate>>,
}

impl InMemoryDvmJobRepository {
    /// An empty queue.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Seeds the queue.
    pub fn set_jobs(&self, jobs: Vec<DvmJob>) {
        *self
            .jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = jobs;
    }

    /// The `(limit, kinds)` of every `find_pending_jobs`.
    pub fn pending_calls(&self) -> Vec<(u64, Option<Vec<Kind>>)> {
        self.pending_calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every successful `assign_worker`.
    pub fn assigned(&self) -> Vec<(EventId, i32)> {
        self.assigned
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every `update_status`.
    pub fn updates(&self) -> Vec<DvmJobUpdate> {
        self.updates
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl DvmJobRepository for InMemoryDvmJobRepository {
    fn create<'a>(
        &'a self,
        id: &'a EventId,
        requester: &'a Pubkey,
        kind: Kind,
    ) -> StorageFuture<'a, DvmJob> {
        Box::pin(async move {
            let now = Utc::now();
            let job = DvmJob {
                id: *id,
                requester_pubkey: *requester,
                kind,
                worker_index: None,
                status: DvmJobStatus::Submitted,
                result_event_id: None,
                error: None,
                picked_up_at: None,
                completed_at: None,
                created_at: now,
                updated_at: now,
            };
            self.jobs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(job.clone());

            Ok(job)
        })
    }

    fn find_by_id<'a>(&'a self, id: &'a EventId) -> StorageFuture<'a, Option<DvmJob>> {
        Box::pin(async move {
            Ok(self
                .jobs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .find(|job| job.id == *id)
                .cloned())
        })
    }

    fn assign_worker<'a>(&'a self, id: &'a EventId, worker_index: i32) -> StorageFuture<'a, bool> {
        Box::pin(async move {
            let mut jobs = self
                .jobs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(job) = jobs.iter_mut().find(|job| job.id == *id) else {
                return Ok(false);
            };

            if job.status != DvmJobStatus::Submitted {
                return Ok(false);
            }

            job.status = DvmJobStatus::PickedUp;
            job.worker_index = Some(worker_index);
            self.assigned
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((*id, worker_index));

            Ok(true)
        })
    }

    fn update_status<'a>(&'a self, update: &'a DvmJobUpdate) -> StorageFuture<'a, Option<DvmJob>> {
        Box::pin(async move {
            self.updates
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(update.clone());

            let mut jobs = self
                .jobs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(job) = jobs.iter_mut().find(|job| job.id == update.id) else {
                return Ok::<Option<DvmJob>, nostream_storage::StorageError>(None);
            };

            job.status = update.status;
            if let FieldUpdate::Set(result) = &update.result_event_id {
                job.result_event_id = Some(*result);
            }
            if let FieldUpdate::Set(error) = &update.error {
                job.error = Some(error.clone());
            }
            job.updated_at = Utc::now();

            Ok(Some(job.clone()))
        })
    }

    fn find_pending_jobs<'a>(
        &'a self,
        limit: u64,
        kinds: Option<&'a [Kind]>,
    ) -> StorageFuture<'a, Vec<DvmJob>> {
        Box::pin(async move {
            self.pending_calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((limit, kinds.map(<[Kind]>::to_vec)));

            let jobs = self
                .jobs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            Ok(jobs
                .iter()
                .filter(|job| {
                    matches!(job.status, DvmJobStatus::Submitted | DvmJobStatus::PickedUp)
                })
                .filter(|job| kinds.is_none_or(|kinds| kinds.contains(&job.kind)))
                .take(limit as usize)
                .cloned()
                .collect())
        })
    }
}

/// A NIP-05 verification repository holding its rows in memory.
#[derive(Debug, Default)]
pub struct InMemoryNip05Repository {
    pending: Mutex<Vec<Nip05Verification>>,
    pending_calls: Mutex<Vec<(i64, i32, u64)>>,
    upserts: Mutex<Vec<Nip05Verification>>,
}

impl InMemoryNip05Repository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Seeds the due list.
    pub fn set_pending(&self, verifications: Vec<Nip05Verification>) {
        *self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = verifications;
    }

    /// The arguments of every `find_pending_verifications`.
    pub fn pending_calls(&self) -> Vec<(i64, i32, u64)> {
        self.pending_calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every `upsert`.
    pub fn upserts(&self) -> Vec<Nip05Verification> {
        self.upserts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl Nip05VerificationRepository for InMemoryNip05Repository {
    fn find_by_pubkey<'a>(
        &'a self,
        pubkey: &'a Pubkey,
    ) -> StorageFuture<'a, Option<Nip05Verification>> {
        Box::pin(async move {
            Ok(self
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .find(|verification| verification.pubkey == *pubkey)
                .cloned())
        })
    }

    fn upsert<'a>(&'a self, verification: &'a Nip05Verification) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            self.upserts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(verification.clone());

            Ok(1)
        })
    }

    fn find_pending_verifications<'a>(
        &'a self,
        update_frequency_ms: i64,
        max_failures: i32,
        limit: u64,
    ) -> StorageFuture<'a, Vec<Nip05Verification>> {
        Box::pin(async move {
            self.pending_calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((update_frequency_ms, max_failures, limit));

            Ok(self
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .take(limit as usize)
                .cloned()
                .collect())
        })
    }

    fn delete_by_pubkey<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, u64> {
        Box::pin(async { Ok(0) })
    }
}

/// A batch persister with a scripted insert count.
#[derive(Debug, Default)]
pub struct RecordingPersister {
    batches: Mutex<Vec<Vec<Event>>>,
    count: Mutex<Option<f64>>,
}

impl RecordingPersister {
    /// A persister that reports every event inserted.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Makes every flush report `count` instead of `batch.len()`.
    pub fn return_count(&self, count: f64) {
        *self
            .count
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(count);
    }

    /// Every flushed batch.
    pub fn batches(&self) -> Vec<Vec<Event>> {
        self.batches
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl crate::services::event_import_service::EventBatchPersister for RecordingPersister {
    fn persist<'a>(
        &'a self,
        events: &'a [Event],
    ) -> Pin<Box<dyn Future<Output = Result<f64, ServicesError>> + Send + 'a>> {
        Box::pin(async move {
            self.batches
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(events.to_vec());

            Ok(self
                .count
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .unwrap_or(events.len() as f64))
        })
    }
}

/// A payment processor double: records the calls and answers a scripted invoice.
#[derive(Debug, Default)]
pub struct RecordingProcessor {
    calls: Mutex<Vec<String>>,
    invoice: Mutex<Option<crate::payments::ProcessorInvoice>>,
    update: Mutex<Option<crate::payments::InvoiceUpdate>>,
    create_error: Mutex<Option<String>>,
    get_error: Mutex<Option<(Option<u16>, String)>>,
    trace: Mutex<Option<Trace>>,
}

impl RecordingProcessor {
    /// A processor with no scripted invoice.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Scripts the created invoice.
    pub fn set_invoice(&self, invoice: crate::payments::ProcessorInvoice) {
        *self
            .invoice
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(invoice);
    }

    /// Scripts the lookup update.
    pub fn set_update(&self, update: crate::payments::InvoiceUpdate) {
        *self
            .update
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(update);
    }

    /// Makes `create_invoice` fail with `message`.
    pub fn fail_create(&self, message: impl Into<String>) {
        *self
            .create_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(message.into());
    }

    /// Makes `get_invoice` fail with an HTTP status.
    pub fn fail_get(&self, status: Option<u16>, message: impl Into<String>) {
        *self
            .get_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((status, message.into()));
    }

    /// Appends this processor's calls to `trace`.
    pub fn set_trace(&self, trace: Trace) {
        *self
            .trace
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(trace);
    }

    /// Every call, in order.
    pub fn calls(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl crate::payments::PaymentProcessor for RecordingProcessor {
    fn processor(&self) -> Option<nostream_config::settings::Processor> {
        Some(nostream_config::settings::Processor::Lnurl)
    }

    fn create_invoice<'a>(
        &'a self,
        amount_msats: i64,
        description: &'a str,
        request_id: &'a str,
    ) -> crate::payments::ProcessorFuture<'a, crate::payments::ProcessorInvoice> {
        Box::pin(async move {
            if let Some(trace) = self
                .trace
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
            {
                trace.push("processor.create_invoice");
            }

            self.calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(format!(
                    "create_invoice({amount_msats}, {description}, {request_id})"
                ));

            if let Some(error) = self
                .create_error
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
            {
                return Err(ServicesError::Payment(error));
            }

            self.invoice
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
                .ok_or_else(|| ServicesError::Payment("no scripted invoice".to_owned()))
        })
    }

    fn get_invoice<'a>(
        &'a self,
        invoice: &'a Invoice,
    ) -> crate::payments::ProcessorFuture<'a, crate::payments::InvoiceUpdate> {
        Box::pin(async move {
            if let Some(trace) = self
                .trace
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
            {
                trace.push("processor.get_invoice");
            }

            self.calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(format!("get_invoice({})", invoice.id));

            if let Some((status, message)) = self
                .get_error
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
            {
                return Err(ServicesError::Http { status, message });
            }

            self.update
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
                .ok_or_else(|| ServicesError::Payment("no scripted update".to_owned()))
        })
    }
}

/// A notification dispatcher recording every call.
#[derive(Debug, Default)]
pub struct RecordingDispatcher {
    calls: Mutex<
        Vec<(
            String,
            OutboxPayload,
            crate::services::operator_notification_service::DispatchContext,
        )>,
    >,
    failing_outbox_ids: Mutex<HashSet<String>>,
}

impl RecordingDispatcher {
    /// A dispatcher that delivers everything.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Makes a dispatch for `outbox_id` fail with `message`.
    pub fn fail_for(&self, outbox_id: &str) {
        self.failing_outbox_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(outbox_id.to_owned());
    }

    /// Every call, in order.
    pub fn calls(
        &self,
    ) -> Vec<(
        String,
        OutboxPayload,
        crate::services::operator_notification_service::DispatchContext,
    )> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl crate::services::operator_notification_service::NotificationDispatcher
    for RecordingDispatcher
{
    fn dispatch<'a>(
        &'a self,
        event_type: &'a str,
        payload: &'a serde_json::Value,
        context: &'a crate::services::operator_notification_service::DispatchContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + 'a>> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((event_type.to_owned(), payload.clone(), context.clone()));

            match context.outbox_id.as_deref() {
                Some(outbox_id)
                    if self
                        .failing_outbox_ids
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .contains(outbox_id) =>
                {
                    Err(ServicesError::Notification(format!(
                        "target: failed for {outbox_id}"
                    )))
                }
                _ => Ok(()),
            }
        })
    }
}

/// One notification target with every field a test needs.
pub fn target(
    id: &str,
    target_type: OperatorNotificationChannelType,
    url: Option<&str>,
) -> OperatorNotificationTarget {
    OperatorNotificationTarget {
        id: id.to_owned(),
        target_type,
        enabled: Some(true),
        url: url.map(|url| Secret(url.to_owned())),
        bot_token: None,
        chat_id: None,
        secret: None,
    }
}

/// A notification block with `targets` and every event enabled.
pub fn notifications(
    enabled: bool,
    targets: Vec<OperatorNotificationTarget>,
) -> AdminNotificationsSettings {
    AdminNotificationsSettings {
        enabled,
        targets,
        events: OperatorNotificationEventToggles::default(),
        retry: OperatorNotificationRetrySettings::default(),
        delivery_log_retention_days: None,
    }
}

/// An outbox message.
pub fn outbox_message(id: &str, attempt_count: i32) -> OutboxMessage {
    let now = Utc::now();

    OutboxMessage {
        id: id.to_owned(),
        event_type: "relay.restarted".to_owned(),
        payload: serde_json::json!({ "version": "0.1.0" }),
        status: nostream_storage::repositories::OutboxStatus::Processing,
        attempt_count,
        available_at: now,
        last_error: None,
        delivered_at: None,
        created_at: now,
        updated_at: now,
    }
}

/// A `WorkerSpec` from a closure, for the scheduler tests.
pub fn worker(
    name: &'static str,
    body: impl Fn(ShutdownStateOf) -> WorkerFutureOf + Send + Sync + 'static,
) -> WorkerSpec {
    WorkerSpec::new(name, Box::new(body))
}

/// The shutdown state a worker body receives.
pub type ShutdownStateOf = nostream_core::lifecycle::ShutdownState;

/// The future a worker body returns.
pub type WorkerFutureOf = Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send>>;

/// A fixed clock at `millis`.
pub fn clock(millis: u64) -> Arc<dyn Clock> {
    Arc::new(nostream_core::clock::TestClock::new(millis))
}

/// A [`ServiceContext`] over fresh doubles: a clock at `millis`, a seeded random source, no
/// relay key, and an empty event store.
pub fn context(settings: nostream_config::Settings) -> crate::context::ServiceContext {
    let (hub, _receiver) = tokio::sync::broadcast::channel(16);
    let http: Arc<dyn crate::http::HttpClient> = RecordingHttpClient::new();
    let fetch: Arc<dyn nostream_core::nip05::Nip05Fetch> = FakeNip05Fetch::new();

    crate::context::ServiceContext {
        settings: Arc::new(settings),
        clock: clock(1_700_000_000_000),
        random: Arc::new(nostream_core::random::SeededRandom::new(7)),
        keys: Arc::new(nostream_relay::relay_key::RelayKeySource::from_values(
            None, None,
        )),
        stores: Arc::new(crate::unavailable::ServiceStores {
            events: InMemoryEventRepository::new(),
            users: InMemoryUserRepository::new(),
            invoices: InMemoryInvoiceRepository::new(),
            nip05: InMemoryNip05Repository::new(),
            dvm_jobs: InMemoryDvmJobRepository::new(),
            notification_outbox: InMemoryOutboxRepository::new(),
            notification_delivery_log: InMemoryDeliveryLogRepository::new(),
        }),
        hub,
        http,
        fetch,
        config_dir: std::path::PathBuf::from("/tmp"),
    }
}

/// A minimal event with a valid signature, for a fixture.
pub fn signed_event(
    secret_key: &[u8; 32],
    kind: Kind,
    tags: Vec<Vec<String>>,
    content: &str,
) -> Event {
    let mut event = Event {
        id: EventId::from_byte_array([0; 32]),
        pubkey: Pubkey::from_byte_array([0; 32]),
        created_at: 1_700_000_000,
        kind,
        tags,
        content: content.to_owned(),
        sig: nostream_core::Signature::from_byte_array([0; 64]),
    };

    nostream_core::crypto::sign_event(secret_key, &mut event).ok();

    event
}

/// A pubkey from a byte.
pub fn pubkey(byte: u8) -> Pubkey {
    Pubkey::from_byte_array([byte; 32])
}
