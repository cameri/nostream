//! The services' store bundle, and the doubles a daemon whose storage backend is not wired
//! yet hands it.
//!
//! The relay has its own `Stores` (`nostream_relay::handlers::Stores`) for the six
//! repositories its handlers call; this bundle carries the seven the services call,
//! including the three the relay's bundle does not (invoices, outbox, delivery log). Every
//! call reports `StorageError::NotImplemented`, which is the workspace's convention for an
//! unwired backend (`CLAUDE.md:148-151`).

use std::sync::Arc;

use nostream_core::EventId;
use nostream_storage::StorageError;
use nostream_storage::repositories::{
    DeliveryLogEntry, DeliveryLogFilters, DvmJob, DvmJobRepository, DvmJobUpdate, EventRecord,
    EventRepository, Invoice, InvoiceRepository, InvoiceStatus, NewDeliveryLogEntry,
    Nip05Verification, Nip05VerificationRepository, NotificationDeliveryLogRepository,
    NotificationOutboxRepository, OutboxMessage, OutboxPayload, QueryStream,
    StorageFuture as StoreFuture, User, UserPatch, UserRepository,
};

/// The seven repositories the services read and write.
#[derive(Clone)]
pub struct ServiceStores {
    pub events: Arc<dyn EventRepository>,
    pub users: Arc<dyn UserRepository>,
    pub invoices: Arc<dyn InvoiceRepository>,
    pub nip05: Arc<dyn Nip05VerificationRepository>,
    pub dvm_jobs: Arc<dyn DvmJobRepository>,
    pub notification_outbox: Arc<dyn NotificationOutboxRepository>,
    pub notification_delivery_log: Arc<dyn NotificationDeliveryLogRepository>,
}

fn unavailable() -> StorageError {
    StorageError::NotImplemented {
        module: "storage::backend::wiring",
    }
}

/// The seven stores, every call reporting `NotImplemented`.
pub fn stores() -> ServiceStores {
    ServiceStores {
        events: Arc::new(UnavailableEventRepository),
        users: Arc::new(UnavailableUserRepository),
        invoices: Arc::new(UnavailableInvoiceRepository),
        nip05: Arc::new(UnavailableNip05Repository),
        dvm_jobs: Arc::new(UnavailableDvmJobRepository),
        notification_outbox: Arc::new(UnavailableOutboxRepository),
        notification_delivery_log: Arc::new(UnavailableDeliveryLogRepository),
    }
}

/// The event store.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableEventRepository;

impl EventRepository for UnavailableEventRepository {
    fn create<'a>(&'a self, _record: &'a EventRecord) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn create_many<'a>(&'a self, _records: &'a [EventRecord]) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn upsert<'a>(&'a self, _record: &'a EventRecord) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn upsert_many<'a>(&'a self, _records: &'a [EventRecord]) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_by_filters<'a>(
        &'a self,
        _filters: &'a [nostream_core::Filter],
    ) -> StoreFuture<'a, QueryStream<'a, EventRecord>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn count_by_filters<'a>(
        &'a self,
        _filters: &'a [nostream_core::Filter],
    ) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_reconciliation_items<'a>(
        &'a self,
        _filter: &'a nostream_core::Filter,
    ) -> StoreFuture<'a, QueryStream<'a, nostream_storage::repositories::ReconciliationItem>>
    {
        Box::pin(async { Err(unavailable()) })
    }

    fn delete_by_pubkey_and_ids<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
        _ids: &'a [EventId],
    ) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn delete_by_pubkey_except_kinds<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
        _excluded_kinds: &'a [nostream_core::Kind],
    ) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn has_active_request_to_vanish<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
    ) -> StoreFuture<'a, bool> {
        Box::pin(async { Err(unavailable()) })
    }

    fn delete_expired_and_retained<'a>(
        &'a self,
        _options: &'a nostream_storage::repositories::EventRetentionOptions,
    ) -> StoreFuture<'a, nostream_storage::repositories::EventPurgeCounts> {
        Box::pin(async { Err(unavailable()) })
    }
}

/// The user store.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableUserRepository;

impl UserRepository for UnavailableUserRepository {
    fn find_by_pubkey<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
    ) -> StoreFuture<'a, Option<User>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn upsert<'a>(&'a self, _user: &'a UserPatch) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn get_balance_by_pubkey<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
    ) -> StoreFuture<'a, i64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn is_vanished<'a>(&'a self, _pubkey: &'a nostream_core::Pubkey) -> StoreFuture<'a, bool> {
        Box::pin(async { Err(unavailable()) })
    }

    fn set_vanished<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
        _vanished: bool,
    ) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn admit_user<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
        _admitted_at: chrono::DateTime<chrono::Utc>,
    ) -> StoreFuture<'a, ()> {
        Box::pin(async { Err(unavailable()) })
    }

    fn revoke_admission<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
    ) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }
}

/// The invoice store.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableInvoiceRepository;

impl InvoiceRepository for UnavailableInvoiceRepository {
    fn find_by_id<'a>(&'a self, _id: &'a str) -> StoreFuture<'a, Option<Invoice>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn upsert<'a>(&'a self, _invoice: &'a Invoice) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn update_status<'a>(
        &'a self,
        _id: &'a str,
        _status: InvoiceStatus,
    ) -> StoreFuture<'a, Option<Invoice>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn confirm_invoice<'a>(
        &'a self,
        _invoice_id: &'a str,
        _amount_received: i64,
        _confirmed_at: chrono::DateTime<chrono::Utc>,
    ) -> StoreFuture<'a, ()> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_pending_invoices<'a>(
        &'a self,
        _offset: u64,
        _limit: u64,
    ) -> StoreFuture<'a, Vec<Invoice>> {
        Box::pin(async { Err(unavailable()) })
    }
}

/// The NIP-05 store.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableNip05Repository;

impl Nip05VerificationRepository for UnavailableNip05Repository {
    fn find_by_pubkey<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
    ) -> StoreFuture<'a, Option<Nip05Verification>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn upsert<'a>(&'a self, _verification: &'a Nip05Verification) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_pending_verifications<'a>(
        &'a self,
        _update_frequency_ms: i64,
        _max_failures: i32,
        _limit: u64,
    ) -> StoreFuture<'a, Vec<Nip05Verification>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn delete_by_pubkey<'a>(
        &'a self,
        _pubkey: &'a nostream_core::Pubkey,
    ) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }
}

/// The DVM job store.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableDvmJobRepository;

impl DvmJobRepository for UnavailableDvmJobRepository {
    fn create<'a>(
        &'a self,
        _id: &'a EventId,
        _requester: &'a nostream_core::Pubkey,
        _kind: nostream_core::Kind,
    ) -> StoreFuture<'a, DvmJob> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_by_id<'a>(&'a self, _id: &'a EventId) -> StoreFuture<'a, Option<DvmJob>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn assign_worker<'a>(
        &'a self,
        _id: &'a EventId,
        _worker_index: i32,
    ) -> StoreFuture<'a, bool> {
        Box::pin(async { Err(unavailable()) })
    }

    fn update_status<'a>(&'a self, _update: &'a DvmJobUpdate) -> StoreFuture<'a, Option<DvmJob>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_pending_jobs<'a>(
        &'a self,
        _limit: u64,
        _kinds: Option<&'a [nostream_core::Kind]>,
    ) -> StoreFuture<'a, Vec<DvmJob>> {
        Box::pin(async { Err(unavailable()) })
    }
}

/// The notification outbox.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableOutboxRepository;

impl NotificationOutboxRepository for UnavailableOutboxRepository {
    fn enqueue<'a>(
        &'a self,
        _event_type: &'a str,
        _payload: &'a OutboxPayload,
    ) -> StoreFuture<'a, OutboxMessage> {
        Box::pin(async { Err(unavailable()) })
    }

    fn claim_batch<'a>(&'a self, _limit: u64) -> StoreFuture<'a, Vec<OutboxMessage>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn mark_delivered<'a>(&'a self, _id: &'a str) -> StoreFuture<'a, ()> {
        Box::pin(async { Err(unavailable()) })
    }

    fn mark_failed<'a>(
        &'a self,
        _id: &'a str,
        _error: &'a str,
        _attempt_count: i32,
        _max_attempts: i32,
        _base_delay_ms: i64,
    ) -> StoreFuture<'a, ()> {
        Box::pin(async { Err(unavailable()) })
    }

    fn delete_terminal_older_than<'a>(
        &'a self,
        _cutoff: chrono::DateTime<chrono::Utc>,
    ) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }
}

/// The notification delivery log.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableDeliveryLogRepository;

impl NotificationDeliveryLogRepository for UnavailableDeliveryLogRepository {
    fn append<'a>(&'a self, _entry: &'a NewDeliveryLogEntry) -> StoreFuture<'a, ()> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_recent<'a>(
        &'a self,
        _limit: u64,
        _filters: &'a DeliveryLogFilters,
    ) -> StoreFuture<'a, Vec<DeliveryLogEntry>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_successful_target_ids<'a>(
        &'a self,
        _outbox_id: &'a str,
    ) -> StoreFuture<'a, Vec<String>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn delete_older_than<'a>(
        &'a self,
        _cutoff: chrono::DateTime<chrono::Utc>,
    ) -> StoreFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }
}
