//! The LMDB environment slice, the trait surface, and the backend's dyn compatibility.

// This integration-test target may unwrap: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;

use nostream_storage::{Backend, LmdbEnv};

#[tokio::test]
async fn the_lmdb_environment_round_trips_a_value() {
    let directory = tempfile::tempdir().expect("tempdir");
    let env = LmdbEnv::open(directory.path(), 1024 * 1024).expect("the environment opens");

    env.put("greeting", "hello").expect("put");
    assert_eq!(env.get("greeting").expect("get"), Some("hello".to_owned()));
    assert_eq!(env.get("absent").expect("get"), None);
    assert_eq!(env.path(), Path::new(directory.path()));
}

#[test]
fn the_backend_parses_the_settings_spelling() {
    assert_eq!(Backend::parse("postgres"), Some(Backend::Postgres));
    assert_eq!(Backend::parse("lmdb"), Some(Backend::Lmdb));
    assert_eq!(Backend::parse("mongodb"), None);
    assert_eq!(Backend::Lmdb.to_string(), "lmdb");
}

#[tokio::test]
async fn the_repository_traits_are_dyn_compatible() {
    // The seam exists so a backend can be picked at runtime: the trait objects must compile.
    // The noop stub proves every vtable exists without touching a database.
    use std::sync::Arc;

    use nostream_core::{EventId, Filter, Kind, Pubkey};
    use nostream_storage::StorageError;
    use nostream_storage::repositories::{
        ActionableTarget, CreateInviteCodeOptions, DeliveryLogEntry, DeliveryLogFilters, DvmJob,
        DvmJobRepository, DvmJobUpdate, EventPurgeCounts, EventRecord, EventRepository,
        EventRetentionOptions, InviteCode, InviteCodeRepository, Invoice, InvoiceRepository,
        InvoiceStatus, NewDeliveryLogEntry, NewReport, Nip05Verification,
        Nip05VerificationRepository, NotificationDeliveryLogRepository,
        NotificationOutboxRepository, OutboxMessage, OutboxPayload, QueryStream,
        ReconciliationItem, Report, ReportRepository, StorageFuture, User, UserPatch,
        UserRepository,
    };

    struct Noop;

    fn unsupported<T>(module: &'static str) -> StorageFuture<'static, T> {
        Box::pin(async move { Err(StorageError::NotImplemented { module }) })
    }

    impl EventRepository for Noop {
        fn create<'a>(&'a self, _record: &'a EventRecord) -> StorageFuture<'a, u64> {
            unsupported("noop::events::create")
        }

        fn create_many<'a>(&'a self, _records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
            unsupported("noop::events::create_many")
        }

        fn upsert<'a>(&'a self, _record: &'a EventRecord) -> StorageFuture<'a, u64> {
            unsupported("noop::events::upsert")
        }

        fn upsert_many<'a>(&'a self, _records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
            unsupported("noop::events::upsert_many")
        }

        fn find_by_filters<'a>(
            &'a self,
            _filters: &'a [Filter],
        ) -> StorageFuture<'a, QueryStream<'a, EventRecord>> {
            unsupported("noop::events::find_by_filters")
        }

        fn count_by_filters<'a>(&'a self, _filters: &'a [Filter]) -> StorageFuture<'a, u64> {
            unsupported("noop::events::count_by_filters")
        }

        fn find_reconciliation_items<'a>(
            &'a self,
            _filter: &'a Filter,
        ) -> StorageFuture<'a, QueryStream<'a, ReconciliationItem>> {
            unsupported("noop::events::find_reconciliation_items")
        }

        fn delete_by_pubkey_and_ids<'a>(
            &'a self,
            _pubkey: &'a Pubkey,
            _ids: &'a [EventId],
        ) -> StorageFuture<'a, u64> {
            unsupported("noop::events::delete_by_pubkey_and_ids")
        }

        fn delete_by_pubkey_except_kinds<'a>(
            &'a self,
            _pubkey: &'a Pubkey,
            _excluded_kinds: &'a [Kind],
        ) -> StorageFuture<'a, u64> {
            unsupported("noop::events::delete_by_pubkey_except_kinds")
        }

        fn has_active_request_to_vanish<'a>(
            &'a self,
            _pubkey: &'a Pubkey,
        ) -> StorageFuture<'a, bool> {
            unsupported("noop::events::has_active_request_to_vanish")
        }

        fn delete_expired_and_retained<'a>(
            &'a self,
            _options: &'a EventRetentionOptions,
        ) -> StorageFuture<'a, EventPurgeCounts> {
            unsupported("noop::events::delete_expired_and_retained")
        }
    }

    impl InvoiceRepository for Noop {
        fn find_by_id<'a>(&'a self, _id: &'a str) -> StorageFuture<'a, Option<Invoice>> {
            unsupported("noop::invoices::find_by_id")
        }

        fn upsert<'a>(&'a self, _invoice: &'a Invoice) -> StorageFuture<'a, u64> {
            unsupported("noop::invoices::upsert")
        }

        fn update_status<'a>(
            &'a self,
            _id: &'a str,
            _status: InvoiceStatus,
        ) -> StorageFuture<'a, Option<Invoice>> {
            unsupported("noop::invoices::update_status")
        }

        fn confirm_invoice<'a>(
            &'a self,
            _invoice_id: &'a str,
            _amount_received: i64,
            _confirmed_at: chrono::DateTime<chrono::Utc>,
        ) -> StorageFuture<'a, ()> {
            unsupported("noop::invoices::confirm_invoice")
        }

        fn find_pending_invoices<'a>(
            &'a self,
            _offset: u64,
            _limit: u64,
        ) -> StorageFuture<'a, Vec<Invoice>> {
            unsupported("noop::invoices::find_pending_invoices")
        }
    }

    impl UserRepository for Noop {
        fn find_by_pubkey<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, Option<User>> {
            unsupported("noop::users::find_by_pubkey")
        }

        fn upsert<'a>(&'a self, _user: &'a UserPatch) -> StorageFuture<'a, u64> {
            unsupported("noop::users::upsert")
        }

        fn get_balance_by_pubkey<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, i64> {
            unsupported("noop::users::get_balance_by_pubkey")
        }

        fn is_vanished<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
            unsupported("noop::users::is_vanished")
        }

        fn set_vanished<'a>(
            &'a self,
            _pubkey: &'a Pubkey,
            _vanished: bool,
        ) -> StorageFuture<'a, u64> {
            unsupported("noop::users::set_vanished")
        }

        fn admit_user<'a>(
            &'a self,
            _pubkey: &'a Pubkey,
            _admitted_at: chrono::DateTime<chrono::Utc>,
        ) -> StorageFuture<'a, ()> {
            unsupported("noop::users::admit_user")
        }

        fn revoke_admission<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, u64> {
            unsupported("noop::users::revoke_admission")
        }
    }

    impl Nip05VerificationRepository for Noop {
        fn find_by_pubkey<'a>(
            &'a self,
            _pubkey: &'a Pubkey,
        ) -> StorageFuture<'a, Option<Nip05Verification>> {
            unsupported("noop::nip05::find_by_pubkey")
        }

        fn upsert<'a>(&'a self, _verification: &'a Nip05Verification) -> StorageFuture<'a, u64> {
            unsupported("noop::nip05::upsert")
        }

        fn find_pending_verifications<'a>(
            &'a self,
            _update_frequency_ms: i64,
            _max_failures: i32,
            _limit: u64,
        ) -> StorageFuture<'a, Vec<Nip05Verification>> {
            unsupported("noop::nip05::find_pending_verifications")
        }

        fn delete_by_pubkey<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, u64> {
            unsupported("noop::nip05::delete_by_pubkey")
        }
    }

    impl InviteCodeRepository for Noop {
        fn create<'a>(
            &'a self,
            _code: &'a str,
            _options: &'a CreateInviteCodeOptions,
        ) -> StorageFuture<'a, InviteCode> {
            unsupported("noop::invites::create")
        }

        fn find_by_code<'a>(&'a self, _code: &'a str) -> StorageFuture<'a, Option<InviteCode>> {
            unsupported("noop::invites::find_by_code")
        }

        fn claim_code<'a>(
            &'a self,
            _code: &'a str,
            _pubkey: &'a Pubkey,
        ) -> StorageFuture<'a, bool> {
            unsupported("noop::invites::claim_code")
        }

        fn find_active_codes<'a>(&'a self, _limit: u64) -> StorageFuture<'a, Vec<InviteCode>> {
            unsupported("noop::invites::find_active_codes")
        }

        fn delete_expired_codes<'a>(&'a self) -> StorageFuture<'a, u64> {
            unsupported("noop::invites::delete_expired_codes")
        }
    }

    impl DvmJobRepository for Noop {
        fn create<'a>(
            &'a self,
            _id: &'a EventId,
            _requester: &'a Pubkey,
            _kind: Kind,
        ) -> StorageFuture<'a, DvmJob> {
            unsupported("noop::dvm::create")
        }

        fn find_by_id<'a>(&'a self, _id: &'a EventId) -> StorageFuture<'a, Option<DvmJob>> {
            unsupported("noop::dvm::find_by_id")
        }

        fn assign_worker<'a>(
            &'a self,
            _id: &'a EventId,
            _worker_index: i32,
        ) -> StorageFuture<'a, bool> {
            unsupported("noop::dvm::assign_worker")
        }

        fn update_status<'a>(
            &'a self,
            _update: &'a DvmJobUpdate,
        ) -> StorageFuture<'a, Option<DvmJob>> {
            unsupported("noop::dvm::update_status")
        }

        fn find_pending_jobs<'a>(
            &'a self,
            _limit: u64,
            _kinds: Option<&'a [Kind]>,
        ) -> StorageFuture<'a, Vec<DvmJob>> {
            unsupported("noop::dvm::find_pending_jobs")
        }
    }

    impl ReportRepository for Noop {
        fn create<'a>(&'a self, _report: &'a NewReport) -> StorageFuture<'a, Report> {
            unsupported("noop::reports::create")
        }

        fn create_many<'a>(&'a self, _reports: &'a [NewReport]) -> StorageFuture<'a, Vec<Report>> {
            unsupported("noop::reports::create_many")
        }

        fn find_by_event_id<'a>(
            &'a self,
            _event_id: &'a EventId,
        ) -> StorageFuture<'a, Vec<Report>> {
            unsupported("noop::reports::find_by_event_id")
        }

        fn find_actionable<'a>(&'a self, _limit: u64) -> StorageFuture<'a, Vec<Report>> {
            unsupported("noop::reports::find_actionable")
        }

        fn find_actionable_targets<'a>(&'a self) -> StorageFuture<'a, Vec<ActionableTarget>> {
            unsupported("noop::reports::find_actionable_targets")
        }
    }

    impl NotificationDeliveryLogRepository for Noop {
        fn append<'a>(&'a self, _entry: &'a NewDeliveryLogEntry) -> StorageFuture<'a, ()> {
            unsupported("noop::delivery_log::append")
        }

        fn find_recent<'a>(
            &'a self,
            _limit: u64,
            _filters: &'a DeliveryLogFilters,
        ) -> StorageFuture<'a, Vec<DeliveryLogEntry>> {
            unsupported("noop::delivery_log::find_recent")
        }

        fn find_successful_target_ids<'a>(
            &'a self,
            _outbox_id: &'a str,
        ) -> StorageFuture<'a, Vec<String>> {
            unsupported("noop::delivery_log::find_successful_target_ids")
        }

        fn delete_older_than<'a>(
            &'a self,
            _cutoff: chrono::DateTime<chrono::Utc>,
        ) -> StorageFuture<'a, u64> {
            unsupported("noop::delivery_log::delete_older_than")
        }
    }

    impl NotificationOutboxRepository for Noop {
        fn enqueue<'a>(
            &'a self,
            _event_type: &'a str,
            _payload: &'a OutboxPayload,
        ) -> StorageFuture<'a, OutboxMessage> {
            unsupported("noop::outbox::enqueue")
        }

        fn claim_batch<'a>(&'a self, _limit: u64) -> StorageFuture<'a, Vec<OutboxMessage>> {
            unsupported("noop::outbox::claim_batch")
        }

        fn mark_delivered<'a>(&'a self, _id: &'a str) -> StorageFuture<'a, ()> {
            unsupported("noop::outbox::mark_delivered")
        }

        fn mark_failed<'a>(
            &'a self,
            _id: &'a str,
            _error: &'a str,
            _attempt_count: i32,
            _max_attempts: i32,
            _base_delay_ms: i64,
        ) -> StorageFuture<'a, ()> {
            unsupported("noop::outbox::mark_failed")
        }

        fn delete_terminal_older_than<'a>(
            &'a self,
            _cutoff: chrono::DateTime<chrono::Utc>,
        ) -> StorageFuture<'a, u64> {
            unsupported("noop::outbox::delete_terminal_older_than")
        }
    }

    let noop = Arc::new(Noop);
    let _: Arc<dyn EventRepository> = noop.clone();
    let _: Arc<dyn InvoiceRepository> = noop.clone();
    let _: Arc<dyn UserRepository> = noop.clone();
    let _: Arc<dyn Nip05VerificationRepository> = noop.clone();
    let _: Arc<dyn InviteCodeRepository> = noop.clone();
    let _: Arc<dyn DvmJobRepository> = noop.clone();
    let _: Arc<dyn ReportRepository> = noop.clone();
    let _: Arc<dyn NotificationDeliveryLogRepository> = noop.clone();
    let _: Arc<dyn NotificationOutboxRepository> = noop;
}

/// The real backend coerces into the same nine forms without a database. Separate from the
/// `Noop` check so the seam still compiles and is tested with the `postgres` feature off.
#[cfg(feature = "postgres")]
#[tokio::test]
async fn the_postgres_backend_coerces_to_all_nine_trait_objects() {
    use nostream_storage::PostgresBackend;
    use nostream_storage::repositories::{
        DvmJobRepository, EventRepository, InviteCodeRepository, InvoiceRepository,
        Nip05VerificationRepository, NotificationDeliveryLogRepository,
        NotificationOutboxRepository, ReportRepository, UserRepository,
    };

    let backend = PostgresBackend::connect_lazy("postgres://postgres:postgres@127.0.0.1/postgres")
        .expect("a lazy backend");
    let _: &dyn EventRepository = &backend;
    let _: &dyn InvoiceRepository = &backend;
    let _: &dyn UserRepository = &backend;
    let _: &dyn Nip05VerificationRepository = &backend;
    let _: &dyn InviteCodeRepository = &backend;
    let _: &dyn DvmJobRepository = &backend;
    let _: &dyn ReportRepository = &backend;
    let _: &dyn NotificationDeliveryLogRepository = &backend;
    let _: &dyn NotificationOutboxRepository = &backend;
}
