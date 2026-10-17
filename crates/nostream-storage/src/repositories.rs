//! The nine repository traits. Mirrors `src/@types/repositories.ts` at the capture commit.
//!
//! Phase 1 carries each trait's representative method set (the capture's interfaces declare
//! five to eleven methods; the full surface is a Phase-2 port), and every implementation is a
//! labelled stub — the 622-line `src/repositories/event-repository.ts` body is **not** ported
//! here. Methods are async and return `Result<_, StorageError>`, which is the one part of the
//! TS boundary (`IQueryResult` extends `Promise`) that ports cleanly to tokio.

use nostream_core::{EventId, Kind, Pubkey};

use crate::error::StorageError;

/// The rows a retention pass deleted, expired and kept (`src/@types/repositories.ts`
/// `EventPurgeCounts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EventPurgeCounts {
    pub deleted: u64,
    pub expired: u64,
    pub retained: u64,
}

/// The options a retention pass takes (`src/@types/repositories.ts` `EventRetentionOptions`).
#[derive(Debug, Clone, Default)]
pub struct EventRetentionOptions {
    pub max_days: Option<i64>,
    pub kind_whitelist: Option<Vec<Kind>>,
    pub pubkey_whitelist: Option<Vec<Pubkey>>,
}

/// Event storage (`src/@types/repositories.ts` `IEventRepository`).
pub trait EventRepository: Send + Sync {
    /// Inserts one event, returning its row id.
    ///
    /// Phase 1 stub — job 005; will insert a canonicalised event row; see `src/repositories/event-repository.ts`.
    fn create(
        &self,
        _event: &nostream_core::Event,
    ) -> impl Future<Output = Result<u64, StorageError>> + Send;

    /// Counts events matching the filters.
    ///
    /// Phase 1 stub — job 005; will count rows through the query builder; see `src/repositories/event-repository.ts`.
    fn count_by_filters(
        &self,
        _filters: &[nostream_core::Filter],
    ) -> impl Future<Output = Result<u64, StorageError>> + Send;

    /// Deletes events by pubkey and ids.
    ///
    /// Phase 1 stub — job 005; will delete NIP-09 deletions; see `src/repositories/event-repository.ts`.
    fn delete_by_pubkey_and_ids(
        &self,
        _pubkey: &Pubkey,
        _ids: &[EventId],
    ) -> impl Future<Output = Result<u64, StorageError>> + Send;

    /// Runs the retention pass.
    ///
    /// Phase 1 stub — job 005; will delete expired and over-retention rows; see `src/repositories/event-repository.ts`.
    fn delete_expired_and_retained(
        &self,
        _options: &EventRetentionOptions,
    ) -> impl Future<Output = Result<EventPurgeCounts, StorageError>> + Send;
}

/// Invoice storage (`src/@types/repositories.ts` `IInvoiceRepository`).
pub trait InvoiceRepository: Send + Sync {
    /// Loads one invoice by id.
    ///
    /// Phase 1 stub — job 005; will load an invoice row; see `src/repositories/invoice-repository.ts`.
    fn find_by_id(
        &self,
        _id: &str,
    ) -> impl Future<Output = Result<Option<Invoice>, StorageError>> + Send;

    /// Upserts an invoice, returning its row id.
    ///
    /// Phase 1 stub — job 005; will insert or update an invoice; see `src/repositories/invoice-repository.ts`.
    fn upsert(&self, _invoice: &Invoice) -> impl Future<Output = Result<u64, StorageError>> + Send;

    /// Loads pending invoices with pagination.
    ///
    /// Phase 1 stub — job 005; will page pending invoices; see `src/repositories/invoice-repository.ts`.
    fn find_pending(
        &self,
        _offset: u64,
        _limit: u64,
    ) -> impl Future<Output = Result<Vec<Invoice>, StorageError>> + Send;
}

/// One payment invoice row (`src/@types/invoice.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invoice {
    pub id: String,
    pub pubkey: Pubkey,
    pub amount: i64,
    pub status: String,
}

/// User and admission storage (`src/@types/repositories.ts` `IUserRepository`).
pub trait UserRepository: Send + Sync {
    /// Loads one user by pubkey.
    ///
    /// Phase 1 stub — job 005; will load a user row; see `src/repositories/user-repository.ts`.
    fn find_by_pubkey(
        &self,
        _pubkey: &Pubkey,
    ) -> impl Future<Output = Result<Option<User>, StorageError>> + Send;

    /// Reads the balance of a pubkey.
    ///
    /// Phase 1 stub — job 005; will read the credited balance; see `src/repositories/user-repository.ts`.
    fn get_balance_by_pubkey(
        &self,
        _pubkey: &Pubkey,
    ) -> impl Future<Output = Result<i64, StorageError>> + Send;

    /// Marks a pubkey admitted.
    ///
    /// Phase 1 stub — job 005; will write the admission timestamp; see `src/repositories/user-repository.ts`.
    fn admit_user(
        &self,
        _pubkey: &Pubkey,
        _admitted_at: i64,
    ) -> impl Future<Output = Result<(), StorageError>> + Send;
}

/// One user row (`src/@types/user.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    pub pubkey: Pubkey,
    pub is_admitted: bool,
    pub balance: i64,
}

/// NIP-05 verification storage (`src/@types/repositories.ts` `INip05VerificationRepository`).
pub trait Nip05VerificationRepository: Send + Sync {
    /// Loads the verification record for a pubkey.
    ///
    /// Phase 1 stub — job 005; will load the verification row; see `src/repositories/nip05-verification-repository.ts`.
    fn find_by_pubkey(
        &self,
        _pubkey: &Pubkey,
    ) -> impl Future<Output = Result<Option<Nip05Verification>, StorageError>> + Send;

    /// Upserts a verification record.
    ///
    /// Phase 1 stub — job 005; will write the verification row; see `src/repositories/nip05-verification-repository.ts`.
    fn upsert(
        &self,
        _verification: &Nip05Verification,
    ) -> impl Future<Output = Result<u64, StorageError>> + Send;
}

/// One NIP-05 verification row (`src/@types/nip05.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nip05Verification {
    pub pubkey: Pubkey,
    pub identifier: String,
    pub verified_at: Option<i64>,
}

/// Invite-code storage (`src/@types/repositories.ts` `IInviteCodeRepository`).
pub trait InviteCodeRepository: Send + Sync {
    /// Creates an invite code with its mint options.
    ///
    /// Phase 1 stub — job 005; will persist a minted code; see `src/repositories/invite-code-repository.ts`.
    fn create(
        &self,
        _code: &str,
        _max_uses: u32,
        _expiry_seconds: u64,
    ) -> impl Future<Output = Result<InviteCode, StorageError>> + Send;

    /// Claims a code for a pubkey, returning whether the claim succeeded.
    ///
    /// Phase 1 stub — job 005; will atomically claim one use of a code; see `src/repositories/invite-code-repository.ts`.
    fn claim_code(
        &self,
        _code: &str,
        _pubkey: &Pubkey,
    ) -> impl Future<Output = Result<bool, StorageError>> + Send;

    /// Deletes expired codes, returning the count.
    ///
    /// Phase 1 stub — job 005; will delete expired codes; see `src/repositories/invite-code-repository.ts`.
    fn delete_expired_codes(&self) -> impl Future<Output = Result<u64, StorageError>> + Send;
}

/// One invite code (`src/@types/invite-code.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteCode {
    pub code: String,
    pub max_uses: u32,
    pub expires_at: Option<i64>,
}

/// DVM job storage (`src/@types/repositories.ts` `IDvmJobRepository`).
pub trait DvmJobRepository: Send + Sync {
    /// Creates a job row for a NIP-90 request.
    ///
    /// Phase 1 stub — job 005; will persist a job request; see `src/repositories/dvm-job-repository.ts`.
    fn create(
        &self,
        _id: &EventId,
        _requester: &Pubkey,
        _kind: Kind,
    ) -> impl Future<Output = Result<DvmJob, StorageError>> + Send;

    /// Assigns a worker to a job.
    ///
    /// Phase 1 stub — job 005; will assign an idle worker; see `src/repositories/dvm-job-repository.ts`.
    fn assign_worker(
        &self,
        _id: &EventId,
        _worker_index: u32,
    ) -> impl Future<Output = Result<bool, StorageError>> + Send;

    /// Loads pending jobs, optionally by kind.
    ///
    /// Phase 1 stub — job 005; will page pending jobs; see `src/repositories/dvm-job-repository.ts`.
    fn find_pending(
        &self,
        _limit: u64,
        _kinds: &[Kind],
    ) -> impl Future<Output = Result<Vec<DvmJob>, StorageError>> + Send;
}

/// One DVM job row (`src/@types/dvm.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DvmJob {
    pub id: EventId,
    pub requester: Pubkey,
    pub kind: Kind,
    pub status: String,
    pub worker_index: Option<u32>,
}

/// Report storage (`src/@types/repositories.ts` `IReportRepository`).
pub trait ReportRepository: Send + Sync {
    /// Creates one report row.
    ///
    /// Phase 1 stub — job 005; will persist a kind-1984 report; see `src/repositories/report-repository.ts`.
    fn create(&self, _report: &Report)
    -> impl Future<Output = Result<Report, StorageError>> + Send;

    /// Loads the reports against one event.
    ///
    /// Phase 1 stub — job 005; will load reports by event id; see `src/repositories/report-repository.ts`.
    fn find_by_event_id(
        &self,
        _event_id: &EventId,
    ) -> impl Future<Output = Result<Vec<Report>, StorageError>> + Send;

    /// Loads actionable reports, up to `limit`.
    ///
    /// Phase 1 stub — job 005; will page actionable reports; see `src/repositories/report-repository.ts`.
    fn find_actionable(
        &self,
        _limit: u64,
    ) -> impl Future<Output = Result<Vec<Report>, StorageError>> + Send;
}

/// One report row (`src/@types/report.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub reporter: Pubkey,
    pub reported_pubkey: Option<Pubkey>,
    pub reported_event_id: Option<EventId>,
    pub report_type: String,
    pub actionable: bool,
}

/// Notification delivery-log storage (`src/@types/repositories.ts`
/// `INotificationDeliveryLogRepository`).
pub trait NotificationDeliveryLogRepository: Send + Sync {
    /// Appends one delivery attempt.
    ///
    /// Phase 1 stub — job 005; will append a delivery log row; see `src/repositories/notification-delivery-log-repository.ts`.
    fn append(
        &self,
        _entry: &DeliveryLogEntry,
    ) -> impl Future<Output = Result<(), StorageError>> + Send;

    /// Loads the recent log, newest first.
    ///
    /// Phase 1 stub — job 005; will page the delivery log; see `src/repositories/notification-delivery-log-repository.ts`.
    fn find_recent(
        &self,
        _limit: u64,
    ) -> impl Future<Output = Result<Vec<DeliveryLogEntry>, StorageError>> + Send;

    /// Deletes entries older than the cutoff, returning the count.
    ///
    /// Phase 1 stub — job 005; will prune old log rows; see `src/repositories/notification-delivery-log-repository.ts`.
    fn delete_older_than(
        &self,
        _cutoff: i64,
    ) -> impl Future<Output = Result<u64, StorageError>> + Send;
}

/// One delivery attempt (`src/@types/operator-notifications.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryLogEntry {
    pub outbox_id: Option<String>,
    pub event_type: String,
    pub target_id: String,
    pub status: String,
    pub attempt_number: u32,
    pub error_snippet: Option<String>,
    pub created_at: i64,
}

/// Notification outbox storage (`src/@types/repositories.ts` `INotificationOutboxRepository`).
pub trait NotificationOutboxRepository: Send + Sync {
    /// Enqueues one notification for delivery.
    ///
    /// Phase 1 stub — job 005; will insert an outbox message; see `src/repositories/notification-outbox-repository.ts`.
    fn enqueue(
        &self,
        _event_type: &str,
        _payload: &str,
    ) -> impl Future<Output = Result<OutboxMessage, StorageError>> + Send;

    /// Claims a batch for delivery.
    ///
    /// Phase 1 stub — job 005; will claim unclaimed messages; see `src/repositories/notification-outbox-repository.ts`.
    fn claim_batch(
        &self,
        _limit: u64,
    ) -> impl Future<Output = Result<Vec<OutboxMessage>, StorageError>> + Send;

    /// Marks a message delivered.
    ///
    /// Phase 1 stub — job 005; will mark delivery success; see `src/repositories/notification-outbox-repository.ts`.
    fn mark_delivered(&self, _id: &str) -> impl Future<Output = Result<(), StorageError>> + Send;
}

/// One outbox message (`src/@types/notification-outbox.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxMessage {
    pub id: String,
    pub event_type: String,
    pub payload: String,
    pub attempt_count: u32,
}
