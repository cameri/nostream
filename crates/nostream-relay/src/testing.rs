//! Test support: in-memory repository doubles and a context factory.
//!
//! The LMDB environment is still a stub (`crates/nostream-storage/src/lib.rs:17-19`), so no
//! test in this job may use a database. These doubles implement the few behaviours the
//! handlers call — insert-returning-a-row-count, stream-by-filter, count, actionable targets,
//! admission, NIP-05, invite codes — with the semantics the capture's Postgres path has.
//!
//! This module is compiled into the library (not `#[cfg(test)]`) because the integration
//! tests and `nostreamd`'s wire test link the crate as a dependency and cannot see a
//! test-only module.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use futures_util::stream;
use nostream_config::settings::{
    Info, Network, Nip42Settings, Nip43Settings, Nip45Settings, Nip50Settings, Nip56Settings,
    RateLimiterSettings, Settings,
};
use nostream_core::clock::Clock;
use nostream_core::{Event, EventId, Filter, Kind, Pubkey};
use nostream_storage::StorageError;
use nostream_storage::repositories::{
    ActionableTarget, CreateInviteCodeOptions, DvmJob, DvmJobStatus, EventPurgeCounts, EventRecord,
    EventRepository, EventRetentionOptions, InviteCode, InviteCodeRepository, Nip05Verification,
    Nip05VerificationRepository, QueryStream, ReconciliationItem, Report, ReportRepository,
    StorageFuture, User, UserPatch, UserRepository,
};

use crate::connection::{Connection, Subscription};
use crate::error::RelayError;
use crate::handlers::{HandlerContext, Stores};
use crate::hidden_content::HiddenContentCache;
use crate::limits::RateLimits;
use crate::relay_key::RelayKeySource;

/// A settings document with the fields the relay reads, and nothing else.
///
/// The values that decide behaviour are the shipped defaults where they matter: no limits,
/// NIP-42/43/45/50/56 off, and `relay_url` on loopback.
pub fn settings() -> Settings {
    Settings {
        info: Info {
            relay_url: "wss://relay.example.com".to_owned(),
            name: "nostream-test".to_owned(),
            description: String::new(),
            banner: None,
            icon: None,
            pubkey: String::new(),
            self_: None,
            contact: String::new(),
            terms_of_service: None,
        },
        admin: None,
        payments: None,
        payments_processors: None,
        network: Network::default(),
        workers: None,
        event_store: None,
        limits: None,
        mirroring: None,
        dvm: None,
        nip05: None,
        nip42: None,
        nip43: None,
        nip45: None,
        nip50: None,
        nip56: None,
        nip66: None,
        wot: None,
    }
}

/// Settings with the EWMA limiter selected explicitly, which is the shipped default.
pub fn settings_with_ewma() -> Settings {
    let mut settings = settings();

    settings.limits = Some(nostream_config::settings::Limits {
        rate_limiter: Some(RateLimiterSettings {
            strategy: nostream_config::settings::RateLimiterStrategy::Ewma,
        }),
        ..Default::default()
    });

    settings
}

/// NIP-42 on, with a zero session TTL (the shipped default) and restricted reads enabled
/// with the default kinds.
pub fn nip42_settings() -> Nip42Settings {
    Nip42Settings {
        auth_required: None,
        session_expiry_seconds: Some(0),
        restricted_reads: Some(nostream_config::settings::Nip42RestrictedReads {
            enabled: true,
            kinds: None,
        }),
    }
}

/// NIP-43 on, invite requests allowed, no whitelist.
pub fn nip43_settings() -> Nip43Settings {
    Nip43Settings {
        enabled: true,
        invite_code_expiry_seconds: None,
        default_max_uses: None,
        allow_invite_requests: Some(true),
        invite_request_whitelist: None,
    }
}

/// NIP-45 on.
pub fn nip45_settings() -> Nip45Settings {
    Nip45Settings {
        enabled: Some(true),
    }
}

/// NIP-50 off, which is the shipped default.
pub fn nip50_settings() -> Nip50Settings {
    Nip50Settings::default()
}

/// NIP-56 on, hiding actionable reports.
pub fn nip56_settings() -> Nip56Settings {
    Nip56Settings {
        enabled: true,
        trusted_moderators: Vec::new(),
        hide_actionable_reports: true,
    }
}

/// An event repository holding its rows in memory.
#[derive(Debug, Default)]
pub struct InMemoryEventRepository {
    records: Mutex<Vec<EventRecord>>,
    fail_count: AtomicBool,
    fail_queries: AtomicBool,
    /// When set, `find_by_filters` holds its stream until a permit is released, which is how
    /// a test gets a read in flight long enough to `CLOSE` it.
    read_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
}

impl InMemoryEventRepository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Seeds `records` with the given events, as stored rows.
    pub fn with_events(events: impl IntoIterator<Item = Event>) -> Arc<Self> {
        let store = Self::default();
        let mut records = store
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        for event in events {
            records.push(EventRecord {
                row_id: None,
                event,
                first_seen: None,
                deleted_at: None,
                expires_at: None,
                event_deduplication: None,
                remote_address: None,
            });
        }

        drop(records);

        Arc::new(store)
    }

    /// Makes every `create` fail, to exercise the handler's error path.
    pub fn fail_create(&self, fail: bool) {
        self.fail_count.store(fail, Ordering::SeqCst);
    }

    /// Makes every `count_by_filters` fail.
    pub fn fail_count(&self) {
        self.fail_queries.store(true, Ordering::SeqCst);
    }

    /// Makes every read wait for a permit. Grant one with `Semaphore::add_permits` to let a
    /// read through.
    pub fn gate_reads(&self) -> Arc<tokio::sync::Semaphore> {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));

        *self
            .read_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&gate));

        gate
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
}

impl EventRepository for InMemoryEventRepository {
    fn create<'a>(&'a self, record: &'a EventRecord) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            if self.fail_count.load(Ordering::SeqCst) {
                return Err(StorageError::InvalidArgument {
                    message: "in-memory double: create failed",
                });
            }

            let mut records = self
                .records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            if records
                .iter()
                .any(|stored| stored.event.id == record.event.id)
            {
                return Ok(0);
            }

            records.push(record.clone());

            Ok(1)
        })
    }

    fn create_many<'a>(&'a self, records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
        Box::pin(async move { Ok(records.len() as u64) })
    }

    fn upsert<'a>(&'a self, record: &'a EventRecord) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let mut records = self
                .records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            records.push(record.clone());

            Ok(1)
        })
    }

    fn upsert_many<'a>(&'a self, records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
        Box::pin(async move { Ok(records.len() as u64) })
    }

    fn find_by_filters<'a>(
        &'a self,
        filters: &'a [Filter],
    ) -> StorageFuture<'a, QueryStream<'a, EventRecord>> {
        let gate = self
            .read_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();

        Box::pin(async move {
            let records = self
                .records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();

            let matched: Vec<Result<EventRecord, StorageError>> = records
                .into_iter()
                .filter(|record| filters.iter().any(|filter| filter.matches(&record.event)))
                .map(Ok)
                .collect();

            let Some(gate) = gate else {
                return Ok(Box::pin(stream::iter(matched)) as QueryStream<'a, EventRecord>);
            };

            let permit = gate
                .acquire_owned()
                .await
                .map_err(|_| StorageError::InvalidArgument {
                    message: "in-memory double: the read gate was closed",
                })?;

            // The permit is held by the stream, so the read stays gated until it completes
            // or the handler drops it.
            let gated = stream::iter(matched).map(move |item| {
                let _held = &permit;

                item
            });

            Ok(Box::pin(gated) as QueryStream<'a, EventRecord>)
        })
    }

    fn count_by_filters<'a>(&'a self, filters: &'a [Filter]) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            if self.fail_queries.load(Ordering::SeqCst) {
                return Err(StorageError::InvalidArgument {
                    message: "in-memory double: count failed",
                });
            }

            let records = self
                .records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            Ok(records
                .iter()
                .filter(|record| filters.iter().any(|filter| filter.matches(&record.event)))
                .count() as u64)
        })
    }

    fn find_reconciliation_items<'a>(
        &'a self,
        _filter: &'a Filter,
    ) -> StorageFuture<'a, QueryStream<'a, ReconciliationItem>> {
        Box::pin(
            async move { Ok(Box::pin(stream::empty()) as QueryStream<'a, ReconciliationItem>) },
        )
    }

    fn delete_by_pubkey_and_ids<'a>(
        &'a self,
        _pubkey: &'a Pubkey,
        _ids: &'a [EventId],
    ) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            Err(StorageError::InvalidArgument {
                message: "in-memory double: not used by these tests",
            })
        })
    }

    fn delete_by_pubkey_except_kinds<'a>(
        &'a self,
        _pubkey: &'a Pubkey,
        _excluded_kinds: &'a [Kind],
    ) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            Err(StorageError::InvalidArgument {
                message: "in-memory double: not used by these tests",
            })
        })
    }

    fn has_active_request_to_vanish<'a>(&'a self, _pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async move { Ok(false) })
    }

    fn delete_expired_and_retained<'a>(
        &'a self,
        _options: &'a EventRetentionOptions,
    ) -> StorageFuture<'a, EventPurgeCounts> {
        Box::pin(async move { Ok(EventPurgeCounts::default()) })
    }
}

/// A user repository holding its rows in memory.
#[derive(Debug, Default)]
pub struct InMemoryUserRepository {
    users: Mutex<BTreeMap<Pubkey, User>>,
}

impl InMemoryUserRepository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Adds or replaces one user row.
    pub fn insert(&self, user: User) {
        self.users
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(user.pubkey, user);
    }
}

impl UserRepository for InMemoryUserRepository {
    fn find_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, Option<User>> {
        Box::pin(async move {
            Ok(self
                .users
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(pubkey)
                .cloned())
        })
    }

    fn upsert<'a>(&'a self, patch: &'a UserPatch) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let now = chrono::Utc::now();
            self.users
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(
                    patch.pubkey,
                    User {
                        pubkey: patch.pubkey,
                        is_admitted: patch.is_admitted,
                        is_vanished: patch.is_vanished,
                        balance: 0,
                        created_at: now,
                        updated_at: now,
                    },
                );

            Ok(1)
        })
    }

    fn get_balance_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, i64> {
        Box::pin(async move {
            Ok(self
                .users
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(pubkey)
                .map_or(0, |user| user.balance))
        })
    }

    fn is_vanished<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async move {
            Ok(self
                .users
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(pubkey)
                .is_some_and(|user| user.is_vanished))
        })
    }

    fn set_vanished<'a>(&'a self, pubkey: &'a Pubkey, vanished: bool) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let mut users = self
                .users
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            match users.get_mut(pubkey) {
                Some(user) => {
                    user.is_vanished = vanished;
                    Ok(1)
                }
                None => Ok(0),
            }
        })
    }

    fn admit_user<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        _admitted_at: chrono::DateTime<chrono::Utc>,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            if let Some(user) = self
                .users
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get_mut(pubkey)
            {
                user.is_admitted = true;
            }

            Ok(())
        })
    }

    fn revoke_admission<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            if let Some(user) = self
                .users
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get_mut(pubkey)
            {
                user.is_admitted = false;
                return Ok(1);
            }

            Ok(0)
        })
    }
}

/// A NIP-05 verification repository holding its rows in memory.
#[derive(Debug, Default)]
pub struct InMemoryNip05Repository {
    rows: Mutex<BTreeMap<Pubkey, Nip05Verification>>,
}

impl InMemoryNip05Repository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Adds or replaces one verification row.
    pub fn insert(&self, verification: Nip05Verification) {
        self.rows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(verification.pubkey, verification);
    }
}

impl Nip05VerificationRepository for InMemoryNip05Repository {
    fn find_by_pubkey<'a>(
        &'a self,
        pubkey: &'a Pubkey,
    ) -> StorageFuture<'a, Option<Nip05Verification>> {
        Box::pin(async move {
            Ok(self
                .rows
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(pubkey)
                .cloned())
        })
    }

    fn upsert<'a>(&'a self, verification: &'a Nip05Verification) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            self.rows
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(verification.pubkey, verification.clone());

            Ok(1)
        })
    }

    fn find_pending_verifications<'a>(
        &'a self,
        _update_frequency_ms: i64,
        _max_failures: i32,
        _limit: u64,
    ) -> StorageFuture<'a, Vec<Nip05Verification>> {
        Box::pin(async move { Ok(Vec::new()) })
    }

    fn delete_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            Ok(self
                .rows
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(pubkey)
                .map_or(0, |_| 1))
        })
    }
}

/// An invite-code repository that records the codes it mints.
#[derive(Debug, Default)]
pub struct InMemoryInviteCodeRepository {
    codes: Mutex<BTreeMap<String, CreateInviteCodeOptions>>,
}

impl InMemoryInviteCodeRepository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The codes minted, in code order, with the options each was minted with.
    pub fn minted(&self) -> Vec<(String, CreateInviteCodeOptions)> {
        self.codes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(code, options)| (code.clone(), options.clone()))
            .collect()
    }
}

impl InviteCodeRepository for InMemoryInviteCodeRepository {
    fn create<'a>(
        &'a self,
        code: &'a str,
        options: &'a CreateInviteCodeOptions,
    ) -> StorageFuture<'a, InviteCode> {
        Box::pin(async move {
            if self
                .codes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(code.to_owned(), options.clone())
                .is_some()
            {
                return Err(StorageError::InvalidArgument {
                    message: "in-memory double: duplicate invite code",
                });
            }

            let now = chrono::Utc::now();

            Ok(InviteCode {
                code: code.to_owned(),
                created_by: options.created_by,
                claimed_by: None,
                expires_at: options.expires_at,
                remaining_uses: match options.remaining_uses {
                    nostream_storage::repositories::FieldUpdate::Set(uses) => Some(uses),
                    _ => None,
                },
                created_at: now,
                updated_at: now,
            })
        })
    }

    fn find_by_code<'a>(&'a self, code: &'a str) -> StorageFuture<'a, Option<InviteCode>> {
        Box::pin(async move {
            Ok(self
                .codes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(code)
                .map(|options| InviteCode {
                    code: code.to_owned(),
                    created_by: options.created_by,
                    claimed_by: None,
                    expires_at: options.expires_at,
                    remaining_uses: None,
                    created_at: chrono::Utc::now(),
                    updated_at: chrono::Utc::now(),
                }))
        })
    }

    fn claim_code<'a>(&'a self, _code: &'a str, _pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async move { Ok(true) })
    }

    fn find_active_codes<'a>(&'a self, _limit: u64) -> StorageFuture<'a, Vec<InviteCode>> {
        Box::pin(async move { Ok(Vec::new()) })
    }

    fn delete_expired_codes<'a>(&'a self) -> StorageFuture<'a, u64> {
        Box::pin(async move { Ok(0) })
    }
}

/// A DVM job repository that records nothing the relay reads.
#[derive(Debug, Default)]
pub struct InMemoryDvmJobRepository;

impl InMemoryDvmJobRepository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self)
    }
}

impl nostream_storage::repositories::DvmJobRepository for InMemoryDvmJobRepository {
    fn create<'a>(
        &'a self,
        id: &'a EventId,
        requester: &'a Pubkey,
        kind: Kind,
    ) -> StorageFuture<'a, DvmJob> {
        Box::pin(async move {
            let now = chrono::Utc::now();

            Ok(DvmJob {
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
            })
        })
    }

    fn find_by_id<'a>(&'a self, _id: &'a EventId) -> StorageFuture<'a, Option<DvmJob>> {
        Box::pin(async move { Ok(None) })
    }

    fn assign_worker<'a>(
        &'a self,
        _id: &'a EventId,
        _worker_index: i32,
    ) -> StorageFuture<'a, bool> {
        Box::pin(async move { Ok(false) })
    }

    fn update_status<'a>(
        &'a self,
        _update: &'a nostream_storage::repositories::DvmJobUpdate,
    ) -> StorageFuture<'a, Option<DvmJob>> {
        Box::pin(async move { Ok(None) })
    }

    fn find_pending_jobs<'a>(
        &'a self,
        _limit: u64,
        _kinds: Option<&'a [Kind]>,
    ) -> StorageFuture<'a, Vec<DvmJob>> {
        Box::pin(async move { Ok(Vec::new()) })
    }
}

/// A report repository with one settable actionable-target snapshot.
#[derive(Debug, Default)]
pub struct InMemoryReportRepository {
    targets: Mutex<Vec<ActionableTarget>>,
    queries: AtomicU64,
    fail_queries: AtomicBool,
}

impl InMemoryReportRepository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Replaces the actionable-target snapshot.
    pub fn set_targets(&self, targets: Vec<ActionableTarget>) {
        *self
            .targets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = targets;
    }

    /// How many `find_actionable_targets` calls have run.
    pub fn queries(&self) -> u64 {
        self.queries.load(Ordering::SeqCst)
    }

    /// Makes every `find_actionable_targets` call fail, as an unavailable database would.
    pub fn fail_queries(&self) {
        self.fail_queries.store(true, Ordering::SeqCst);
    }
}

impl ReportRepository for InMemoryReportRepository {
    fn create<'a>(
        &'a self,
        _report: &'a nostream_storage::repositories::NewReport,
    ) -> StorageFuture<'a, Report> {
        Box::pin(async move {
            Err(StorageError::InvalidArgument {
                message: "in-memory double: not used by these tests",
            })
        })
    }

    fn create_many<'a>(
        &'a self,
        _reports: &'a [nostream_storage::repositories::NewReport],
    ) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async move { Ok(Vec::new()) })
    }

    fn find_by_event_id<'a>(&'a self, _event_id: &'a EventId) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async move { Ok(Vec::new()) })
    }

    fn find_actionable<'a>(&'a self, _limit: u64) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async move { Ok(Vec::new()) })
    }

    fn find_actionable_targets<'a>(&'a self) -> StorageFuture<'a, Vec<ActionableTarget>> {
        self.queries.fetch_add(1, Ordering::SeqCst);

        if self.fail_queries.load(Ordering::SeqCst) {
            return Box::pin(async move {
                Err(StorageError::InvalidArgument {
                    message: "in-memory double: the report query failed",
                })
            });
        }

        Box::pin(async move {
            Ok(self
                .targets
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone())
        })
    }
}

/// A limiter whose store always fails, for the fail-closed paths.
#[derive(Debug, Default, Clone, Copy)]
pub struct FailingLimiter;

impl crate::limits::Limiter for FailingLimiter {
    fn hit(
        &self,
        _key: &str,
        _step: u64,
        _config: &crate::limits::RateLimitConfig,
    ) -> Result<bool, RelayError> {
        Err(RelayError::RateLimiter(
            "in-memory double: the store failed".to_owned(),
        ))
    }

    fn strategy(&self) -> nostream_config::settings::RateLimiterStrategy {
        nostream_config::settings::RateLimiterStrategy::Ewma
    }
}

/// The six doubles as one [`Stores`] value.
pub fn stores(
    events: Arc<InMemoryEventRepository>,
    users: Arc<InMemoryUserRepository>,
    nip05: Arc<InMemoryNip05Repository>,
    invites: Arc<InMemoryInviteCodeRepository>,
    reports: Arc<InMemoryReportRepository>,
) -> Arc<Stores> {
    Arc::new(Stores {
        events,
        users,
        nip05,
        invites,
        dvm_jobs: InMemoryDvmJobRepository::new(),
        reports,
    })
}

/// The parts of a [`HandlerContext`] a test builds before adding its own socket.
pub struct Fixture {
    pub settings: Arc<Settings>,
    pub stores: Arc<Stores>,
    pub events: Arc<InMemoryEventRepository>,
    pub users: Arc<InMemoryUserRepository>,
    pub nip05: Arc<InMemoryNip05Repository>,
    pub invites: Arc<InMemoryInviteCodeRepository>,
    pub reports: Arc<InMemoryReportRepository>,
    pub hidden: Arc<HiddenContentCache>,
    pub hub: tokio::sync::broadcast::Sender<Event>,
}

impl Fixture {
    /// A fixture over fresh, empty doubles.
    pub fn new(settings: Settings) -> Self {
        let events = InMemoryEventRepository::new();
        let users = InMemoryUserRepository::new();
        let nip05 = InMemoryNip05Repository::new();
        let invites = InMemoryInviteCodeRepository::new();
        let reports = InMemoryReportRepository::new();
        let (hub, _receiver) = tokio::sync::broadcast::channel(64);

        Self {
            settings: Arc::new(settings),
            stores: stores(
                Arc::clone(&events),
                Arc::clone(&users),
                Arc::clone(&nip05),
                Arc::clone(&invites),
                Arc::clone(&reports),
            ),
            events,
            users,
            nip05,
            invites,
            reports,
            hidden: HiddenContentCache::new(),
            hub,
        }
    }

    /// Stores one event as a live row, for a test that reads it back.
    pub async fn seed_event(&self, event: Event) {
        let record = EventRecord {
            row_id: None,
            event,
            first_seen: None,
            deleted_at: None,
            expires_at: None,
            event_deduplication: None,
            remote_address: None,
        };

        let _ = EventRepository::create(self.events.as_ref(), &record).await;
    }

    /// A handler context for one socket, with the given clock and key source.
    pub fn context(
        &self,
        clock: Arc<dyn Clock>,
        keys: RelayKeySource,
        connection: Arc<Connection>,
        sink: crate::sink::FrameSink,
    ) -> HandlerContext {
        let limits = Arc::new(RateLimits::new(&self.settings, Arc::clone(&clock)));

        self.context_with_limits(clock, keys, connection, sink, limits)
    }

    /// A handler context over explicit rate limits, which is how a failing store is wired.
    pub fn context_with_limits(
        &self,
        clock: Arc<dyn Clock>,
        keys: RelayKeySource,
        connection: Arc<Connection>,
        sink: crate::sink::FrameSink,
        limits: Arc<RateLimits>,
    ) -> HandlerContext {
        HandlerContext {
            settings: Arc::clone(&self.settings),
            clock: Arc::clone(&clock),
            random: Arc::new(nostream_core::random::SeededRandom::new(0)),
            sink,
            connection,
            stores: Arc::clone(&self.stores),
            limits,
            hidden: Arc::clone(&self.hidden),
            keys: Arc::new(keys),
            broadcast: self.hub.clone(),
            pow: Arc::new(Mutex::new(
                nostream_core::adaptive_pow::AdaptivePowState::default(),
            )),
        }
    }

    /// A context whose sink drops everything and whose socket has authenticated as `pubkey`.
    pub fn anonymous_context(&self, clock: Arc<dyn Clock>, keys: RelayKeySource) -> HandlerContext {
        let connection = Arc::new(Connection::new(
            "127.0.0.1".to_owned(),
            nostream_core::nip42::Nip42Session::with_challenge("challenge", 0),
        ));

        self.context(clock, keys, connection, crate::sink::FrameSink::closed())
    }

    /// A context connected as `pubkey`, with a sink that drops everything.
    pub fn authenticated_context(
        &self,
        clock: Arc<dyn Clock>,
        keys: RelayKeySource,
        pubkey: Pubkey,
    ) -> HandlerContext {
        let context = self.anonymous_context(clock, keys);

        context.connection.authenticate(
            pubkey,
            EventId::from_byte_array([9; 32]),
            context.now_secs(),
        );

        context
    }

    /// Registers one subscription on the context's socket.
    pub fn subscribe(&self, context: &HandlerContext, id: &str, filters: Vec<Filter>) {
        context.connection.subscribe(Subscription {
            id: id.to_owned(),
            filters,
        });
    }
}

/// A broadcast receiver over the fixture's hub.
pub fn hub_receiver(
    hub: &tokio::sync::broadcast::Sender<Event>,
) -> tokio::sync::broadcast::Receiver<Event> {
    hub.subscribe()
}
