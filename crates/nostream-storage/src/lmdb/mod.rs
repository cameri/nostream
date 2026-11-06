//! The LMDB backend: one environment, the 29 named databases, and the nine repository traits.
//! Mirrors `src/repositories/` through the seam the Postgres backend also implements, and
//! `docs/rewrite/decisions/0010-lmdb-backend.md` records why each choice below was made.
//!
//! Every heed call runs inside `tokio::task::spawn_blocking`, because `Env::write_txn` blocks
//! its thread on the single writer's mutex and a read transaction must not be held across an
//! await. A repository method is one whole write transaction, so it is atomic across every
//! database it touches.

mod encoding;
mod events;
mod invoices;
mod metadata;
mod notifications;
mod rows;
mod users;

use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use heed::types::Bytes;
use heed::{Database, Env, RoTxn, RwTxn};
use nostream_config::Settings;
use nostream_core::{EventId, Filter, Kind, Pubkey};

use crate::backend::LmdbEnv;
use crate::error::StorageError;
use crate::repositories::{
    ActionableTarget, CreateInviteCodeOptions, DeliveryLogEntry, DeliveryLogFilters, DvmJob,
    DvmJobRepository, DvmJobUpdate, EventPurgeCounts, EventRecord, EventRepository,
    EventRetentionOptions, InviteCode, InviteCodeRepository, Invoice, InvoiceRepository,
    InvoiceStatus, NewDeliveryLogEntry, NewReport, Nip05Verification, Nip05VerificationRepository,
    NotificationDeliveryLogRepository, NotificationOutboxRepository, OutboxMessage, OutboxPayload,
    QueryStream, ReconciliationItem, Report, ReportRepository, StorageFuture, User, UserPatch,
    UserRepository,
};

/// The fixed map size every environment is opened with: `Env::resize` is `unsafe` and this
/// crate has one audited `unsafe` call, so the map is preallocated at 64 GiB and never grown.
///
/// shortcut: the map is fixed at 64 GiB and never grown; upgrade when a deployment's data can
/// approach it, which needs `Env::resize` (a second `unsafe` call) or a refusal at open.
pub const LMDB_MAP_SIZE: usize = 64 << 30;

/// The number of named databases the environment reserves, comfortably above the 29 it opens.
///
/// shortcut: 29 databases open under a reserve of 64; upgrade when a tenth repository or a new
/// query path crosses that reserve, which moves this value and every store's reopen path.
pub const LMDB_MAX_DBS: u32 = 64;

/// The number of concurrent read transactions the environment reserves.
pub const LMDB_MAX_READERS: u32 = 512;

/// The capture's default page size (`DEFAULT_FILTER_LIMIT`).
pub(crate) const DEFAULT_FILTER_LIMIT: u64 = 500;

/// The largest page a read materialises, however large a limit the wire asks for.
///
/// `limits.client.subscription.maxLimit` is the relay's own bound, but it is applied only when
/// the deployment sets it, and a request reaches the store before some of those gates; this is
/// the backend's bound, so the size of a read's resident set is never chosen by the client.
/// 5 000 is exactly the shipped `maxLimit` (`resources/default-settings.yaml`), so the clamp
/// cannot shorten a page a configured relay would have served.
pub(crate) const MAX_PAGE_KEYS: usize = 5_000;

/// The retention batch size (`RETENTION_BATCH_SIZE`).
pub(crate) const RETENTION_BATCH_SIZE: usize = 1_000;

/// How many rows one stream poll copies before it drops its read transaction.
pub(crate) const STREAM_BATCH_ITEMS: usize = 256;

/// How many index keys one reconciliation poll evaluates before it drops its read transaction.
/// A filter that matches few of the keys it walks ends a batch on this count rather than on
/// [`STREAM_BATCH_ITEMS`], so the transaction never spans a whole range.
pub(crate) const STREAM_BATCH_KEYS: usize = 256;

/// The settings gates the capture reads per query. The LMDB backend records only whether
/// NIP-50 is on: it has no search implementation (ADR 0010, Out of scope).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Gates {
    pub(crate) nip50: bool,
    pub(crate) nip56: bool,
}

/// The named databases of one environment.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Databases {
    pub(crate) events: Database<Bytes, Bytes>,
    pub(crate) events_by_created_at: Database<Bytes, Bytes>,
    pub(crate) events_by_author: Database<Bytes, Bytes>,
    pub(crate) events_deleted: Database<Bytes, Bytes>,
    pub(crate) events_expiring: Database<Bytes, Bytes>,
    pub(crate) replaceable: Database<Bytes, Bytes>,
    pub(crate) tags: Database<Bytes, Bytes>,
    pub(crate) users: Database<Bytes, Bytes>,
    pub(crate) invoices: Database<Bytes, Bytes>,
    pub(crate) invoices_pending: Database<Bytes, Bytes>,
    pub(crate) nip05: Database<Bytes, Bytes>,
    pub(crate) nip05_by_last_checked_at: Database<Bytes, Bytes>,
    pub(crate) invite_codes: Database<Bytes, Bytes>,
    pub(crate) invite_codes_by_created_at: Database<Bytes, Bytes>,
    pub(crate) invite_codes_by_expires_at: Database<Bytes, Bytes>,
    pub(crate) dvm_jobs: Database<Bytes, Bytes>,
    pub(crate) dvm_jobs_by_status_created_at: Database<Bytes, Bytes>,
    pub(crate) reports: Database<Bytes, Bytes>,
    pub(crate) reports_by_event_id: Database<Bytes, Bytes>,
    pub(crate) reports_actionable_by_created_at: Database<Bytes, Bytes>,
    pub(crate) reports_actionable_event: Database<Bytes, Bytes>,
    pub(crate) reports_actionable_pubkey: Database<Bytes, Bytes>,
    pub(crate) outbox: Database<Bytes, Bytes>,
    pub(crate) outbox_by_status_created_at: Database<Bytes, Bytes>,
    pub(crate) outbox_by_status_updated_at: Database<Bytes, Bytes>,
    pub(crate) notification_delivery_log: Database<Bytes, Bytes>,
    pub(crate) delivery_log_by_created_at: Database<Bytes, Bytes>,
    pub(crate) delivery_log_by_outbox: Database<Bytes, Bytes>,
    pub(crate) meta: Database<Bytes, Bytes>,
}

impl Databases {
    /// Creates (or opens) every database inside the caller's write transaction.
    fn create(env: &Env, txn: &mut RwTxn<'_>) -> Result<Self, StorageError> {
        Ok(Self {
            events: env.create_database(txn, Some("events"))?,
            events_by_created_at: env.create_database(txn, Some("events_by_created_at"))?,
            events_by_author: env.create_database(txn, Some("events_by_author"))?,
            events_deleted: env.create_database(txn, Some("events_deleted"))?,
            events_expiring: env.create_database(txn, Some("events_expiring"))?,
            replaceable: env.create_database(txn, Some("replaceable"))?,
            tags: env.create_database(txn, Some("tags"))?,
            users: env.create_database(txn, Some("users"))?,
            invoices: env.create_database(txn, Some("invoices"))?,
            invoices_pending: env.create_database(txn, Some("invoices_pending"))?,
            nip05: env.create_database(txn, Some("nip05_verifications"))?,
            nip05_by_last_checked_at: env.create_database(txn, Some("nip05_by_last_checked_at"))?,
            invite_codes: env.create_database(txn, Some("invite_codes"))?,
            invite_codes_by_created_at: env
                .create_database(txn, Some("invite_codes_by_created_at"))?,
            invite_codes_by_expires_at: env
                .create_database(txn, Some("invite_codes_by_expires_at"))?,
            dvm_jobs: env.create_database(txn, Some("dvm_jobs"))?,
            dvm_jobs_by_status_created_at: env
                .create_database(txn, Some("dvm_jobs_by_status_created_at"))?,
            reports: env.create_database(txn, Some("reports"))?,
            reports_by_event_id: env.create_database(txn, Some("reports_by_event_id"))?,
            reports_actionable_by_created_at: env
                .create_database(txn, Some("reports_actionable_by_created_at"))?,
            reports_actionable_event: env.create_database(txn, Some("reports_actionable_event"))?,
            reports_actionable_pubkey: env
                .create_database(txn, Some("reports_actionable_pubkey"))?,
            outbox: env.create_database(txn, Some("notification_outbox"))?,
            outbox_by_status_created_at: env
                .create_database(txn, Some("outbox_by_status_created_at"))?,
            outbox_by_status_updated_at: env
                .create_database(txn, Some("outbox_by_status_updated_at"))?,
            notification_delivery_log: env
                .create_database(txn, Some("notification_delivery_log"))?,
            delivery_log_by_created_at: env
                .create_database(txn, Some("delivery_log_by_created_at"))?,
            delivery_log_by_outbox: env.create_database(txn, Some("delivery_log_by_outbox"))?,
            meta: env.create_database(txn, Some("meta"))?,
        })
    }
}

/// How much of the fixed map one store has used (`Env::non_free_pages_size`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MapUsage {
    /// The ceiling the store never grows past.
    pub map_size: usize,
    /// The bytes the pages in use occupy, as of the last committed transaction.
    pub used_bytes: u64,
}

/// An embedded LMDB event store with its metadata tail, built from the root a caller supplies.
#[derive(Debug, Clone)]
pub struct LmdbBackend {
    env: Env,
    databases: Databases,
    settings: Option<Arc<Settings>>,
}

impl LmdbBackend {
    /// Opens (creating if needed) the store under `<root>/lmdb` and creates every database.
    ///
    /// The usage it reports is what the map's approach to [`LMDB_MAP_SIZE`] is read from: the
    /// store never grows, so an operator sees it coming here rather than at the first failed
    /// write.
    pub async fn open(root: impl Into<PathBuf>) -> Result<Self, StorageError> {
        let root = root.into();
        // The same rule `data_dir` answers, from the same constant.
        let path = root.join(crate::backend::LMDB_DIR);
        let opened = tokio::task::spawn_blocking(move || {
            let environment = LmdbEnv::open(&path, LMDB_MAP_SIZE)?;
            let handle = environment.env().clone();
            let mut transaction = handle.write_txn()?;
            let databases = Databases::create(&handle, &mut transaction)?;
            transaction.commit()?;
            let used_bytes = handle.non_free_pages_size()?;
            Ok::<_, StorageError>((environment, databases, used_bytes))
        })
        .await
        .map_err(|_| StorageError::LmdbTaskCancelled)??;
        let (environment, databases, used_bytes) = opened;

        tracing::info!(
            path = %environment.path().display(),
            map_size = LMDB_MAP_SIZE,
            used_bytes,
            used_percent = used_bytes as f64 / LMDB_MAP_SIZE as f64 * 100.0,
            "the lmdb store is open"
        );

        Ok(Self {
            env: environment.env().clone(),
            databases,
            settings: None,
        })
    }

    /// How much of the fixed map the store has used, for an operator's tooling and the log
    /// line [`open`](Self::open) writes.
    pub fn map_usage(&self) -> Result<MapUsage, StorageError> {
        Ok(MapUsage {
            map_size: LMDB_MAP_SIZE,
            used_bytes: self.env.non_free_pages_size()?,
        })
    }

    /// Supplies the `nip50`/`nip56` gates. Absent settings mean both features are off.
    pub fn with_settings(mut self, settings: Arc<Settings>) -> Self {
        self.settings = Some(settings);
        self
    }

    /// The environment handle, for an operator's tooling.
    pub fn env(&self) -> &Env {
        &self.env
    }

    pub(crate) fn gates(&self) -> Gates {
        let Some(settings) = &self.settings else {
            return Gates::default();
        };
        Gates {
            nip50: settings
                .nip50
                .as_ref()
                .is_some_and(|nip50| nip50.enabled == Some(true)),
            nip56: settings
                .nip56
                .as_ref()
                .is_some_and(|nip56| nip56.enabled && nip56.hide_actionable_reports),
        }
    }

    /// Runs one write transaction on the blocking pool; an error rolls it back.
    pub(crate) async fn write<T, F>(&self, work: F) -> Result<T, StorageError>
    where
        T: Send + 'static,
        F: FnOnce(&mut RwTxn<'_>, &Databases) -> Result<T, StorageError> + Send + 'static,
    {
        let env = self.env.clone();
        let databases = self.databases;
        tokio::task::spawn_blocking(move || {
            let mut transaction = env.write_txn()?;
            let value = work(&mut transaction, &databases)?;
            transaction.commit()?;
            Ok(value)
        })
        .await
        .map_err(|_| StorageError::LmdbTaskCancelled)?
    }

    /// Runs one read transaction on the blocking pool.
    pub(crate) async fn read<T, F>(&self, work: F) -> Result<T, StorageError>
    where
        T: Send + 'static,
        F: FnOnce(&RoTxn<'_>, &Databases) -> Result<T, StorageError> + Send + 'static,
    {
        let env = self.env.clone();
        let databases = self.databases;
        tokio::task::spawn_blocking(move || {
            let transaction = env.read_txn()?;
            work(&transaction, &databases)
        })
        .await
        .map_err(|_| StorageError::LmdbTaskCancelled)?
    }
}

impl EventRepository for LmdbBackend {
    fn create<'a>(&'a self, record: &'a EventRecord) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let record = record.clone();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                events::create(txn, databases, std::slice::from_ref(&record), now)
            })
            .await
        })
    }

    fn create_many<'a>(&'a self, records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let records = records.to_vec();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| events::create(txn, databases, &records, now))
                .await
        })
    }

    fn upsert<'a>(&'a self, record: &'a EventRecord) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let record = record.clone();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| events::upsert(txn, databases, &record, now))
                .await
        })
    }

    fn upsert_many<'a>(&'a self, records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let records = records.to_vec();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| events::upsert_many(txn, databases, &records, now))
                .await
        })
    }

    fn find_by_filters<'a>(
        &'a self,
        filters: &'a [Filter],
    ) -> StorageFuture<'a, QueryStream<'a, EventRecord>> {
        Box::pin(async move {
            let filters = filters.to_vec();
            let gates = self.gates();
            let now = Utc::now().timestamp();
            let page = self
                .read(move |txn, databases| events::page(txn, databases, &filters, &gates, now))
                .await?;
            let stream: QueryStream<'_, EventRecord> = Box::pin(events::ValuesStream::new(
                self.env.clone(),
                self.databases,
                &page,
            ));
            Ok(stream)
        })
    }

    fn count_by_filters<'a>(&'a self, filters: &'a [Filter]) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let filters = filters.to_vec();
            let gates = self.gates();
            let now = Utc::now().timestamp();
            self.read(move |txn, databases| events::count(txn, databases, &filters, &gates, now))
                .await
        })
    }

    fn find_reconciliation_items<'a>(
        &'a self,
        filter: &'a Filter,
    ) -> StorageFuture<'a, QueryStream<'a, ReconciliationItem>> {
        Box::pin(async move {
            let filter = filter.clone();
            let gates = self.gates();
            let now = Utc::now().timestamp();
            let stream: QueryStream<'_, ReconciliationItem> =
                Box::pin(events::ReconciliationStream::new(
                    self.env.clone(),
                    self.databases,
                    &filter,
                    gates,
                    now,
                ));
            Ok(stream)
        })
    }

    fn delete_by_pubkey_and_ids<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        ids: &'a [EventId],
    ) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let pubkey = *pubkey;
            let ids = ids.to_vec();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                events::delete_by_pubkey_and_ids(txn, databases, &pubkey, &ids, now)
            })
            .await
        })
    }

    fn delete_by_pubkey_except_kinds<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        excluded_kinds: &'a [Kind],
    ) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let pubkey = *pubkey;
            let kinds = excluded_kinds.to_vec();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                events::delete_by_pubkey_except_kinds(txn, databases, &pubkey, &kinds, now)
            })
            .await
        })
    }

    fn has_active_request_to_vanish<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async move {
            let pubkey = *pubkey;
            self.read(move |txn, databases| {
                events::has_active_request_to_vanish(txn, databases, &pubkey)
            })
            .await
        })
    }

    fn delete_expired_and_retained<'a>(
        &'a self,
        options: &'a EventRetentionOptions,
    ) -> StorageFuture<'a, EventPurgeCounts> {
        Box::pin(async move {
            let options = options.clone();
            let now = Utc::now().timestamp();
            self.write(move |txn, databases| {
                events::delete_expired_and_retained(txn, databases, &options, now)
            })
            .await
        })
    }
}

impl InvoiceRepository for LmdbBackend {
    fn find_by_id<'a>(&'a self, id: &'a str) -> StorageFuture<'a, Option<Invoice>> {
        Box::pin(async move {
            let id = id.to_owned();
            self.read(move |txn, databases| invoices::find_by_id(txn, databases, &id))
                .await
        })
    }

    fn upsert<'a>(&'a self, invoice: &'a Invoice) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let invoice = invoice.clone();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| invoices::upsert(txn, databases, &invoice, now))
                .await
        })
    }

    fn update_status<'a>(
        &'a self,
        id: &'a str,
        status: InvoiceStatus,
    ) -> StorageFuture<'a, Option<Invoice>> {
        Box::pin(async move {
            let id = id.to_owned();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                invoices::update_status(txn, databases, &id, status, now)
            })
            .await
        })
    }

    fn confirm_invoice<'a>(
        &'a self,
        invoice_id: &'a str,
        amount_received: i64,
        confirmed_at: chrono::DateTime<Utc>,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            let invoice_id = invoice_id.to_owned();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                invoices::confirm_invoice(
                    txn,
                    databases,
                    &invoice_id,
                    amount_received,
                    confirmed_at,
                    now,
                )
            })
            .await
        })
    }

    fn find_pending_invoices<'a>(
        &'a self,
        offset: u64,
        limit: u64,
    ) -> StorageFuture<'a, Vec<Invoice>> {
        Box::pin(async move {
            self.read(move |txn, databases| {
                invoices::find_pending_invoices(txn, databases, offset, limit)
            })
            .await
        })
    }
}

impl UserRepository for LmdbBackend {
    fn find_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, Option<User>> {
        Box::pin(async move {
            let pubkey = *pubkey;
            self.read(move |txn, databases| users::find_by_pubkey(txn, databases, &pubkey))
                .await
        })
    }

    fn upsert<'a>(&'a self, user: &'a UserPatch) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let user = user.clone();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| users::upsert(txn, databases, &user, now))
                .await
        })
    }

    fn get_balance_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, i64> {
        Box::pin(async move {
            let pubkey = *pubkey;
            self.read(move |txn, databases| users::get_balance_by_pubkey(txn, databases, &pubkey))
                .await
        })
    }

    fn is_vanished<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async move {
            let pubkey = *pubkey;
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| users::is_vanished(txn, databases, &pubkey, now))
                .await
        })
    }

    fn set_vanished<'a>(&'a self, pubkey: &'a Pubkey, vanished: bool) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let pubkey = *pubkey;
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                users::upsert_vanish_state(txn, databases, &pubkey, vanished, now)
            })
            .await
        })
    }

    fn admit_user<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        admitted_at: chrono::DateTime<Utc>,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            let pubkey = *pubkey;
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                users::admit_user(txn, databases, &pubkey, admitted_at, now)
            })
            .await
        })
    }

    fn revoke_admission<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let pubkey = *pubkey;
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| users::revoke_admission(txn, databases, &pubkey, now))
                .await
        })
    }
}

impl Nip05VerificationRepository for LmdbBackend {
    fn find_by_pubkey<'a>(
        &'a self,
        pubkey: &'a Pubkey,
    ) -> StorageFuture<'a, Option<Nip05Verification>> {
        Box::pin(async move {
            let pubkey = *pubkey;
            self.read(move |txn, databases| metadata::nip05_find_by_pubkey(txn, databases, &pubkey))
                .await
        })
    }

    fn upsert<'a>(&'a self, verification: &'a Nip05Verification) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let verification = verification.clone();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                metadata::nip05_upsert(txn, databases, &verification, now)
            })
            .await
        })
    }

    fn find_pending_verifications<'a>(
        &'a self,
        update_frequency_ms: i64,
        max_failures: i32,
        limit: u64,
    ) -> StorageFuture<'a, Vec<Nip05Verification>> {
        Box::pin(async move {
            let now = encoding::micros(Utc::now());
            self.read(move |txn, databases| {
                metadata::nip05_find_pending(
                    txn,
                    databases,
                    update_frequency_ms,
                    max_failures,
                    limit,
                    now,
                )
            })
            .await
        })
    }

    fn delete_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let pubkey = *pubkey;
            self.write(move |txn, databases| {
                metadata::nip05_delete_by_pubkey(txn, databases, &pubkey)
            })
            .await
        })
    }
}

impl InviteCodeRepository for LmdbBackend {
    fn create<'a>(
        &'a self,
        code: &'a str,
        options: &'a CreateInviteCodeOptions,
    ) -> StorageFuture<'a, InviteCode> {
        Box::pin(async move {
            let code = code.to_owned();
            let options = options.clone();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                metadata::invite_create(txn, databases, &code, &options, now)
            })
            .await
        })
    }

    fn find_by_code<'a>(&'a self, code: &'a str) -> StorageFuture<'a, Option<InviteCode>> {
        Box::pin(async move {
            let code = code.to_owned();
            self.read(move |txn, databases| metadata::invite_find_by_code(txn, databases, &code))
                .await
        })
    }

    fn claim_code<'a>(&'a self, code: &'a str, pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async move {
            let code = code.to_owned();
            let pubkey = *pubkey;
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                metadata::invite_claim_code(txn, databases, &code, &pubkey, now)
            })
            .await
        })
    }

    fn find_active_codes<'a>(&'a self, limit: u64) -> StorageFuture<'a, Vec<InviteCode>> {
        Box::pin(async move {
            let now = encoding::micros(Utc::now());
            self.read(move |txn, databases| {
                metadata::invite_find_active_codes(txn, databases, limit, now)
            })
            .await
        })
    }

    fn delete_expired_codes<'a>(&'a self) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| metadata::invite_delete_expired(txn, databases, now))
                .await
        })
    }
}

impl DvmJobRepository for LmdbBackend {
    fn create<'a>(
        &'a self,
        id: &'a EventId,
        requester: &'a Pubkey,
        kind: Kind,
    ) -> StorageFuture<'a, DvmJob> {
        Box::pin(async move {
            let id = *id;
            let requester = *requester;
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                metadata::dvm_create(txn, databases, &id, &requester, kind, now)
            })
            .await
        })
    }

    fn find_by_id<'a>(&'a self, id: &'a EventId) -> StorageFuture<'a, Option<DvmJob>> {
        Box::pin(async move {
            let id = *id;
            self.read(move |txn, databases| metadata::dvm_find_by_id(txn, databases, &id))
                .await
        })
    }

    fn assign_worker<'a>(&'a self, id: &'a EventId, worker_index: i32) -> StorageFuture<'a, bool> {
        Box::pin(async move {
            let id = *id;
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                metadata::dvm_assign_worker(txn, databases, &id, worker_index, now)
            })
            .await
        })
    }

    fn update_status<'a>(&'a self, update: &'a DvmJobUpdate) -> StorageFuture<'a, Option<DvmJob>> {
        Box::pin(async move {
            let update = update.clone();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                metadata::dvm_update_status(txn, databases, &update, now)
            })
            .await
        })
    }

    fn find_pending_jobs<'a>(
        &'a self,
        limit: u64,
        kinds: Option<&'a [Kind]>,
    ) -> StorageFuture<'a, Vec<DvmJob>> {
        Box::pin(async move {
            let kinds = kinds.map(<[Kind]>::to_vec);
            self.read(move |txn, databases| {
                metadata::dvm_find_pending_jobs(txn, databases, limit, kinds.as_deref())
            })
            .await
        })
    }
}

impl ReportRepository for LmdbBackend {
    fn create<'a>(&'a self, report: &'a NewReport) -> StorageFuture<'a, Report> {
        Box::pin(async move {
            let report = report.clone();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| metadata::report_create(txn, databases, &report, now))
                .await
        })
    }

    fn create_many<'a>(&'a self, reports: &'a [NewReport]) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async move {
            let reports = reports.to_vec();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                let mut created = Vec::with_capacity(reports.len());
                for report in &reports {
                    created.push(metadata::report_create(txn, databases, report, now)?);
                }
                Ok(created)
            })
            .await
        })
    }

    fn find_by_event_id<'a>(&'a self, event_id: &'a EventId) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async move {
            let event_id = *event_id;
            self.read(move |txn, databases| {
                metadata::report_find_by_event_id(txn, databases, &event_id)
            })
            .await
        })
    }

    fn find_actionable<'a>(&'a self, limit: u64) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async move {
            self.read(move |txn, databases| metadata::report_find_actionable(txn, databases, limit))
                .await
        })
    }

    fn find_actionable_targets<'a>(&'a self) -> StorageFuture<'a, Vec<ActionableTarget>> {
        Box::pin(async move { self.read(metadata::report_find_actionable_targets).await })
    }
}

impl NotificationDeliveryLogRepository for LmdbBackend {
    fn append<'a>(&'a self, entry: &'a NewDeliveryLogEntry) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            let entry = entry.clone();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| notifications::append(txn, databases, &entry, now))
                .await
        })
    }

    fn find_recent<'a>(
        &'a self,
        limit: u64,
        filters: &'a DeliveryLogFilters,
    ) -> StorageFuture<'a, Vec<DeliveryLogEntry>> {
        Box::pin(async move {
            let filters = filters.clone();
            self.read(move |txn, databases| {
                notifications::find_recent(txn, databases, limit, &filters)
            })
            .await
        })
    }

    fn find_successful_target_ids<'a>(
        &'a self,
        outbox_id: &'a str,
    ) -> StorageFuture<'a, Vec<String>> {
        Box::pin(async move {
            let outbox_id = outbox_id.to_owned();
            self.read(move |txn, databases| {
                notifications::find_successful_target_ids(txn, databases, &outbox_id)
            })
            .await
        })
    }

    fn delete_older_than<'a>(&'a self, cutoff: chrono::DateTime<Utc>) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            self.write(move |txn, databases| {
                notifications::delete_older_than(txn, databases, cutoff)
            })
            .await
        })
    }
}

impl NotificationOutboxRepository for LmdbBackend {
    fn enqueue<'a>(
        &'a self,
        event_type: &'a str,
        payload: &'a OutboxPayload,
    ) -> StorageFuture<'a, OutboxMessage> {
        Box::pin(async move {
            let event_type = event_type.to_owned();
            let payload = payload.clone();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                notifications::enqueue(txn, databases, &event_type, &payload, now)
            })
            .await
        })
    }

    fn claim_batch<'a>(&'a self, limit: u64) -> StorageFuture<'a, Vec<OutboxMessage>> {
        Box::pin(async move {
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| notifications::claim_batch(txn, databases, limit, now))
                .await
        })
    }

    fn mark_delivered<'a>(&'a self, id: &'a str) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            let id = id.to_owned();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                notifications::mark_delivered(txn, databases, &id, now)
            })
            .await
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
            let id = id.to_owned();
            let error = error.to_owned();
            let now = encoding::micros(Utc::now());
            self.write(move |txn, databases| {
                notifications::mark_failed(
                    txn,
                    databases,
                    &id,
                    &error,
                    attempt_count,
                    max_attempts,
                    base_delay_ms,
                    now,
                )
            })
            .await
        })
    }

    fn delete_terminal_older_than<'a>(
        &'a self,
        cutoff: chrono::DateTime<Utc>,
    ) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            self.write(move |txn, databases| {
                notifications::delete_terminal_older_than(txn, databases, cutoff)
            })
            .await
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[tokio::test]
    async fn the_backend_opens_and_creates_every_database() {
        let directory = tempfile::tempdir().expect("tempdir");
        let backend = LmdbBackend::open(directory.path())
            .await
            .expect("the store opens");
        let transaction = backend.env.read_txn().expect("a read transaction");
        for name in [
            "events",
            "events_by_created_at",
            "events_by_author",
            "events_deleted",
            "events_expiring",
            "replaceable",
            "tags",
            "users",
            "meta",
            "delivery_log_by_outbox",
        ] {
            let database = backend
                .env
                .open_database::<Bytes, Bytes>(&transaction, Some(name))
                .expect("the database opens");
            assert!(database.is_some(), "{name} exists");
        }
    }

    #[tokio::test]
    async fn the_store_reports_how_much_of_its_map_it_uses() {
        // The map never grows (LMDB_MAP_SIZE), so the approach to it is what an operator has to
        // see; before this the first signal was the first failed write.
        let directory = tempfile::tempdir().expect("tempdir");
        let backend = LmdbBackend::open(directory.path())
            .await
            .expect("the store opens");
        let usage = backend.map_usage().expect("the usage");
        assert_eq!(usage.map_size, LMDB_MAP_SIZE);
        assert!(usage.used_bytes > 0, "the 29 databases occupy pages");
        assert!(usage.used_bytes <= LMDB_MAP_SIZE as u64);
    }

    #[tokio::test]
    async fn absent_settings_leave_both_gates_off() {
        let directory = tempfile::tempdir().expect("tempdir");
        let backend = LmdbBackend::open(directory.path())
            .await
            .expect("the store opens");
        let gates = backend.gates();
        assert!(!gates.nip50);
        assert!(!gates.nip56);
    }

    #[tokio::test]
    async fn a_named_database_past_the_maximum_is_refused() {
        // The environment reserves LMDB_MAX_DBS handles; the 29 the backend opens leave the
        // rest free, and the 65th creation has to fail rather than silently succeed.
        let directory = tempfile::tempdir().expect("tempdir");
        let backend = LmdbBackend::open(directory.path())
            .await
            .expect("the store opens");
        let mut transaction = backend.env.write_txn().expect("a write transaction");
        let mut created = 0;
        for index in 0..LMDB_MAX_DBS {
            let name = format!("probe-{index}");
            if backend
                .env
                .create_database::<Bytes, Bytes>(&mut transaction, Some(&name))
                .is_err()
            {
                break;
            }
            created += 1;
        }
        assert!(created < LMDB_MAX_DBS, "the handle limit is enforced");
        transaction.abort();
    }

    #[tokio::test]
    async fn a_store_filled_past_its_map_size_reports_the_driver_error() {
        // A small map is the only way to reach the boundary the fixed LMDB_MAP_SIZE stands
        // in for: the environment never grows, so a full one is the driver's error (V27).
        let directory = tempfile::tempdir().expect("tempdir");
        let environment =
            LmdbEnv::open(directory.path().join("map"), 1 << 20).expect("a 1 MiB environment");
        let env = environment.env().clone();
        let mut transaction = env.write_txn().expect("a write transaction");
        let database = env
            .create_database::<Bytes, Bytes>(&mut transaction, Some("fill"))
            .expect("a database");

        let value = vec![0u8; 64 << 10];
        let mut written = 0u32;
        loop {
            match database.put(&mut transaction, &written.to_be_bytes(), &value) {
                Ok(()) => written += 1,
                Err(error) => {
                    let error = StorageError::from(error);
                    assert!(
                        matches!(error, StorageError::Lmdb(_)),
                        "a full map is the driver's error, got {error:?}"
                    );
                    break;
                }
            }
        }
        assert!(written > 0, "the map held rows before it filled");
        transaction.abort();
    }
}
