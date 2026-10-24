//! Repository seams for a daemon whose storage backend is not wired yet.
//!
//! The relay is generic over `nostream-storage`'s repository traits, and the daemon has no
//! live backend to hand it: the LMDB environment is a labelled stub
//! (`crates/nostream-storage/src/lib.rs:17-19`) and the Postgres backend needs a database the
//! daemon is not yet configured with. Wiring these seams keeps the wire served — handshake,
//! NIP-42 challenge, REQ/COUNT validation — while every storage call reports
//! `StorageError::NotImplemented`, which is the workspace's convention for an unwired
//! backend (`CLAUDE.md:148-151`).

use nostream_core::{EventId, Filter, Kind, Pubkey};
use nostream_storage::StorageError;
use nostream_storage::repositories::{
    ActionableTarget, CreateInviteCodeOptions, DvmJob, DvmJobUpdate, EventPurgeCounts, EventRecord,
    EventRepository, EventRetentionOptions, InviteCode, InviteCodeRepository, Nip05Verification,
    Nip05VerificationRepository, QueryStream, ReconciliationItem, Report, ReportRepository,
    StorageFuture, User, UserPatch, UserRepository,
};

use crate::handlers::Stores;

/// The six seams, every call reporting `NotImplemented`.
pub fn stores() -> Stores {
    Stores {
        events: std::sync::Arc::new(UnavailableEventRepository),
        users: std::sync::Arc::new(UnavailableUserRepository),
        nip05: std::sync::Arc::new(UnavailableNip05Repository),
        invites: std::sync::Arc::new(UnavailableInviteCodeRepository),
        dvm_jobs: std::sync::Arc::new(UnavailableDvmJobRepository),
        reports: std::sync::Arc::new(UnavailableReportRepository),
    }
}

fn unavailable() -> StorageError {
    StorageError::NotImplemented {
        module: "storage::backend::wiring",
    }
}

/// The event store.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableEventRepository;

impl EventRepository for UnavailableEventRepository {
    fn create<'a>(&'a self, _record: &'a EventRecord) -> StorageFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn create_many<'a>(&'a self, _records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn upsert<'a>(&'a self, _record: &'a EventRecord) -> StorageFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn upsert_many<'a>(&'a self, _records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_by_filters<'a>(
        &'a self,
        _filters: &'a [Filter],
    ) -> StorageFuture<'a, QueryStream<'a, EventRecord>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn count_by_filters<'a>(&'a self, _filters: &'a [Filter]) -> StorageFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_reconciliation_items<'a>(
        &'a self,
        _filter: &'a Filter,
    ) -> StorageFuture<'a, QueryStream<'a, ReconciliationItem>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn delete_by_pubkey_and_ids<'a>(
        &'a self,
        _pubkey: &'a Pubkey,
        _ids: &'a [EventId],
    ) -> StorageFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn delete_by_pubkey_except_kinds<'a>(
        &'a self,
        _pubkey: &'a Pubkey,
        _excluded_kinds: &'a [Kind],
    ) -> StorageFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn has_active_request_to_vanish<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async { Err(unavailable()) })
    }

    fn delete_expired_and_retained<'a>(
        &'a self,
        _options: &'a EventRetentionOptions,
    ) -> StorageFuture<'a, EventPurgeCounts> {
        Box::pin(async { Err(unavailable()) })
    }
}

/// The user store.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableUserRepository;

impl UserRepository for UnavailableUserRepository {
    fn find_by_pubkey<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, Option<User>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn upsert<'a>(&'a self, _user: &'a UserPatch) -> StorageFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn get_balance_by_pubkey<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, i64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn is_vanished<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async { Err(unavailable()) })
    }

    fn set_vanished<'a>(&'a self, _pubkey: &'a Pubkey, _vanished: bool) -> StorageFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn admit_user<'a>(
        &'a self,
        _pubkey: &'a Pubkey,
        _admitted_at: chrono::DateTime<chrono::Utc>,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async { Err(unavailable()) })
    }

    fn revoke_admission<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }
}

/// The NIP-05 store.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableNip05Repository;

impl Nip05VerificationRepository for UnavailableNip05Repository {
    fn find_by_pubkey<'a>(
        &'a self,
        _pubkey: &'a Pubkey,
    ) -> StorageFuture<'a, Option<Nip05Verification>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn upsert<'a>(&'a self, _verification: &'a Nip05Verification) -> StorageFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_pending_verifications<'a>(
        &'a self,
        _update_frequency_ms: i64,
        _max_failures: i32,
        _limit: u64,
    ) -> StorageFuture<'a, Vec<Nip05Verification>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn delete_by_pubkey<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }
}

/// The invite-code store.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableInviteCodeRepository;

impl InviteCodeRepository for UnavailableInviteCodeRepository {
    fn create<'a>(
        &'a self,
        _code: &'a str,
        _options: &'a CreateInviteCodeOptions,
    ) -> StorageFuture<'a, InviteCode> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_by_code<'a>(&'a self, _code: &'a str) -> StorageFuture<'a, Option<InviteCode>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn claim_code<'a>(&'a self, _code: &'a str, _pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_active_codes<'a>(&'a self, _limit: u64) -> StorageFuture<'a, Vec<InviteCode>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn delete_expired_codes<'a>(&'a self) -> StorageFuture<'a, u64> {
        Box::pin(async { Err(unavailable()) })
    }
}

/// The DVM job store.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableDvmJobRepository;

impl nostream_storage::repositories::DvmJobRepository for UnavailableDvmJobRepository {
    fn create<'a>(
        &'a self,
        _id: &'a EventId,
        _requester: &'a Pubkey,
        _kind: Kind,
    ) -> StorageFuture<'a, DvmJob> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_by_id<'a>(&'a self, _id: &'a EventId) -> StorageFuture<'a, Option<DvmJob>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn assign_worker<'a>(
        &'a self,
        _id: &'a EventId,
        _worker_index: i32,
    ) -> StorageFuture<'a, bool> {
        Box::pin(async { Err(unavailable()) })
    }

    fn update_status<'a>(&'a self, _update: &'a DvmJobUpdate) -> StorageFuture<'a, Option<DvmJob>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_pending_jobs<'a>(
        &'a self,
        _limit: u64,
        _kinds: Option<&'a [Kind]>,
    ) -> StorageFuture<'a, Vec<DvmJob>> {
        Box::pin(async { Err(unavailable()) })
    }
}

/// The report store.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableReportRepository;

impl ReportRepository for UnavailableReportRepository {
    fn create<'a>(
        &'a self,
        _report: &'a nostream_storage::repositories::NewReport,
    ) -> StorageFuture<'a, Report> {
        Box::pin(async { Err(unavailable()) })
    }

    fn create_many<'a>(
        &'a self,
        _reports: &'a [nostream_storage::repositories::NewReport],
    ) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_by_event_id<'a>(&'a self, _event_id: &'a EventId) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_actionable<'a>(&'a self, _limit: u64) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn find_actionable_targets<'a>(&'a self) -> StorageFuture<'a, Vec<ActionableTarget>> {
        Box::pin(async { Err(unavailable()) })
    }
}
