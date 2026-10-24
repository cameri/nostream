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
    EventRepository, EventRetentionOptions, FieldUpdate, InviteCode, InviteCodeRepository,
    NewReport, Nip05Verification, Nip05VerificationRepository, QueryStream, ReconciliationItem,
    Report, ReportRepository, StorageFuture, User, UserPatch, UserRepository,
};

use crate::connection::{Connection, Subscription};
use crate::error::RelayError;
use crate::handlers::{HandlerContext, Stores};
use crate::hidden_content::HiddenContentCache;
use crate::limits::RateLimits;
use crate::relay_key::RelayKeySource;
use crate::wot::{WotFuture, WotGraph};

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

/// What [`InMemoryEventRepository::fail_upsert`] makes `upsert` answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpsertFailure {
    /// A store that cannot be reached.
    Unavailable,
    /// The event id already exists (`StorageError::DuplicateEvent`).
    DuplicateEvent,
}

/// An event repository holding its rows in memory.
#[derive(Debug, Default)]
pub struct InMemoryEventRepository {
    records: Mutex<Vec<EventRecord>>,
    fail_count: AtomicBool,
    fail_queries: AtomicBool,
    fail_delete: AtomicBool,
    upsert_failure: Mutex<Option<UpsertFailure>>,
    upserts: Mutex<Vec<Vec<serde_json::Value>>>,
    deletes: Mutex<Vec<(Pubkey, Vec<EventId>)>>,
    delete_except_kinds_calls: Mutex<Vec<(Pubkey, Vec<Kind>)>>,
    /// When set, `find_by_filters` holds its stream until a permit is released, which is how
    /// a test gets a read in flight long enough to `CLOSE` it.
    read_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    gate_per_item: std::sync::atomic::AtomicBool,
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
        self.install_gate(false)
    }

    /// Makes a read wait for one permit **per record**, so a test can let one record through,
    /// change the connection's state, and let the next one through — the only way to observe
    /// a decision taken per event rather than once per read.
    pub fn gate_reads_per_item(&self) -> Arc<tokio::sync::Semaphore> {
        self.install_gate(true)
    }

    fn install_gate(&self, per_item: bool) -> Arc<tokio::sync::Semaphore> {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));

        *self
            .read_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&gate));
        self.gate_per_item
            .store(per_item, std::sync::atomic::Ordering::SeqCst);

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

    /// The events a read still returns, in insertion order: the rows no soft delete touched.
    pub fn live_events(&self) -> Vec<Event> {
        self.records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .filter(|record| record.deleted_at.is_none())
            .map(|record| record.event.clone())
            .collect()
    }

    /// The deduplication key each `upsert` was asked to write, in call order.
    pub fn upserts(&self) -> Vec<Vec<serde_json::Value>> {
        self.upserts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The `(pubkey, ids)` each `delete_by_pubkey_and_ids` was called with.
    pub fn deletes(&self) -> Vec<(Pubkey, Vec<EventId>)> {
        self.deletes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The `(pubkey, excluded kinds)` each `delete_by_pubkey_except_kinds` was called with.
    pub fn delete_except_kinds_calls(&self) -> Vec<(Pubkey, Vec<Kind>)> {
        self.delete_except_kinds_calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Makes every `upsert` answer `failure` before it looks at a row.
    pub fn fail_upsert(&self, failure: UpsertFailure) {
        *self
            .upsert_failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(failure);
    }

    /// Makes both soft deletes fail.
    pub fn fail_delete(&self) {
        self.fail_delete.store(true, Ordering::SeqCst);
    }

    /// Soft-deletes every live row matching `predicate`, returning how many it touched.
    fn soft_delete(&self, predicate: impl Fn(&EventRecord) -> bool) -> u64 {
        let now = chrono::Utc::now();
        let mut records = self
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut deleted = 0;

        for record in records.iter_mut() {
            if record.deleted_at.is_none() && predicate(record) {
                record.deleted_at = Some(now);
                deleted += 1;
            }
        }

        deleted
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

    /// The capture's `INSERT … ON CONFLICT (event_pubkey, event_kind, event_deduplication)`:
    /// the conflict target applies to replaceable kinds only, the incoming row wins when it
    /// supersedes the stored one, and the answer is whether a row was written.
    fn upsert<'a>(&'a self, record: &'a EventRecord) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let deduplication = record.deduplication();

            self.upserts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(deduplication.clone());

            if let Some(failure) = *self
                .upsert_failure
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
            {
                return Err(match failure {
                    UpsertFailure::Unavailable => StorageError::InvalidArgument {
                        message: "connection lost",
                    },
                    UpsertFailure::DuplicateEvent => StorageError::DuplicateEvent,
                });
            }

            let mut records = self
                .records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            if record.event.kind.is_replaceable()
                || record.event.kind.is_parameterized_replaceable()
            {
                let stored = records.iter_mut().find(|stored| {
                    stored.event.pubkey == record.event.pubkey
                        && stored.event.kind == record.event.kind
                        && stored.deduplication() == deduplication
                });

                if let Some(stored) = stored {
                    if !nostream_core::replaceable::supersedes(
                        &record.event,
                        stored.event.created_at,
                        &stored.event.id,
                    ) {
                        return Ok(0);
                    }

                    *stored = record.clone();

                    return Ok(1);
                }
            }

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
        let per_item = self.gate_per_item.load(std::sync::atomic::Ordering::SeqCst);

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

            if per_item {
                // One permit per record, and the permits are held rather than returned, so
                // one release lets exactly one record through.
                let held = Arc::new(Mutex::new(Vec::new()));
                let gated = stream::iter(matched).then(move |item| {
                    let gate = Arc::clone(&gate);
                    let held = Arc::clone(&held);

                    async move {
                        match gate.acquire_owned().await {
                            Ok(permit) => {
                                held.lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                                    .push(permit);

                                item
                            }
                            Err(_) => Err(StorageError::InvalidArgument {
                                message: "in-memory double: the read gate was closed",
                            }),
                        }
                    }
                });

                return Ok(Box::pin(gated) as QueryStream<'a, EventRecord>);
            }

            let permit = gate
                .acquire_owned()
                .await
                .map_err(|_| StorageError::InvalidArgument {
                    message: "in-memory double: the read gate was closed",
                })?;

            // The permit is held by the stream, so the read stays gated until it completes or
            // the handler drops it.
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

    /// `UPDATE … SET deleted_at = now()` for the given ids of one author, skipping kind 62.
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

            if self.fail_delete.load(Ordering::SeqCst) {
                return Err(StorageError::InvalidArgument {
                    message: "in-memory double: the delete failed",
                });
            }

            Ok(self.soft_delete(|record| {
                record.event.pubkey == *pubkey
                    && ids.contains(&record.event.id)
                    && record.event.kind != Kind::REQUEST_TO_VANISH
            }))
        })
    }

    /// The same soft delete over every live row of one author but the excluded kinds.
    fn delete_by_pubkey_except_kinds<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        excluded_kinds: &'a [Kind],
    ) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            self.delete_except_kinds_calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((*pubkey, excluded_kinds.to_vec()));

            if self.fail_delete.load(Ordering::SeqCst) {
                return Err(StorageError::InvalidArgument {
                    message: "in-memory double: the delete failed",
                });
            }

            Ok(self.soft_delete(|record| {
                record.event.pubkey == *pubkey && !excluded_kinds.contains(&record.event.kind)
            }))
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
    vanish_calls: Mutex<Vec<(Pubkey, bool)>>,
    fail_reads: AtomicBool,
}

impl InMemoryUserRepository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Makes every read fail, as an unavailable database would.
    pub fn fail_reads(&self) {
        self.fail_reads.store(true, Ordering::SeqCst);
    }

    /// Adds or replaces one user row.
    pub fn insert(&self, user: User) {
        self.users
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(user.pubkey, user);
    }

    /// The `(pubkey, vanished)` each `set_vanished` was called with.
    pub fn vanish_calls(&self) -> Vec<(Pubkey, bool)> {
        self.vanish_calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl UserRepository for InMemoryUserRepository {
    fn find_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, Option<User>> {
        if self.fail_reads.load(Ordering::SeqCst) {
            return Box::pin(async move {
                Err(StorageError::InvalidArgument {
                    message: "in-memory double: the user read failed",
                })
            });
        }

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

    /// The capture's insert-on-conflict-merge (`src/repositories/user-repository.ts:75-92`):
    /// an absent row is created, so the flag lands for a pubkey this relay has never seen.
    fn set_vanished<'a>(&'a self, pubkey: &'a Pubkey, vanished: bool) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            self.vanish_calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((*pubkey, vanished));

            let now = chrono::Utc::now();
            let mut users = self
                .users
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let user = users.entry(*pubkey).or_insert_with(|| User {
                pubkey: *pubkey,
                is_admitted: false,
                is_vanished: false,
                balance: 0,
                created_at: now,
                updated_at: now,
            });

            user.is_vanished = vanished;
            user.updated_at = now;

            Ok(1)
        })
    }

    /// The capture's `admit_user` function: an upsert, so a pubkey with no row gets one.
    fn admit_user<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        _admitted_at: chrono::DateTime<chrono::Utc>,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            let now = chrono::Utc::now();
            let mut users = self
                .users
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let user = users.entry(*pubkey).or_insert_with(|| User {
                pubkey: *pubkey,
                is_admitted: false,
                is_vanished: false,
                balance: 0,
                created_at: now,
                updated_at: now,
            });

            user.is_admitted = true;
            user.updated_at = now;

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
    fail_reads: AtomicBool,
}

impl InMemoryNip05Repository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Makes every read fail, as an unavailable database would.
    pub fn fail_reads(&self) {
        self.fail_reads.store(true, Ordering::SeqCst);
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
        if self.fail_reads.load(Ordering::SeqCst) {
            return Box::pin(async move {
                Err(StorageError::InvalidArgument {
                    message: "in-memory double: the nip05 read failed",
                })
            });
        }

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

/// One invite code as the double holds it: the mint options, plus the claim state a claim
/// mutates.
#[derive(Debug, Clone)]
struct InviteCodeRow {
    options: CreateInviteCodeOptions,
    claimed_by: Option<Pubkey>,
    /// `None` is no limit at all, which is the capture's `Clear`.
    remaining_uses: Option<i32>,
}

impl InviteCodeRow {
    fn code(&self, code: &str) -> InviteCode {
        let now = chrono::Utc::now();

        InviteCode {
            code: code.to_owned(),
            created_by: self.options.created_by,
            claimed_by: self.claimed_by,
            expires_at: self.options.expires_at,
            remaining_uses: self.remaining_uses,
            created_at: now,
            updated_at: now,
        }
    }
}

/// An invite-code repository that records the codes it mints and claims.
#[derive(Debug, Default)]
pub struct InMemoryInviteCodeRepository {
    codes: Mutex<BTreeMap<String, InviteCodeRow>>,
    claims: Mutex<Vec<(String, Pubkey)>>,
    fail_claims: AtomicBool,
    /// When set, `create` holds until a permit is released, which is how a test keeps the
    /// invite mint's one `await` open long enough for a `CLOSE` to land in it.
    create_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    creates: AtomicU64,
}

impl InMemoryInviteCodeRepository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Makes every `create` wait for a permit. Grant one with `Semaphore::add_permits` to
    /// let the mint through.
    ///
    /// A gate rather than a sleeping double: `RateLimits::invite_limited` is synchronous and
    /// a sleep in it would block the runtime a single-threaded `#[tokio::test]` runs on.
    pub fn gate_creates(&self) -> Arc<tokio::sync::Semaphore> {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));

        *self
            .create_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&gate));

        gate
    }

    /// How many `create` calls have started, including one a gate is holding.
    pub fn creates_started(&self) -> u64 {
        self.creates.load(Ordering::SeqCst)
    }

    /// The codes minted, in code order, with the options each was minted with.
    pub fn minted(&self) -> Vec<(String, CreateInviteCodeOptions)> {
        self.codes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(code, row)| (code.clone(), row.options.clone()))
            .collect()
    }

    /// The `(code, pubkey)` each `claim_code` was called with, in call order.
    pub fn claims(&self) -> Vec<(String, Pubkey)> {
        self.claims
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Makes every `claim_code` fail as an unavailable store would.
    pub fn fail_claims(&self) {
        self.fail_claims.store(true, Ordering::SeqCst);
    }
}

impl InviteCodeRepository for InMemoryInviteCodeRepository {
    fn create<'a>(
        &'a self,
        code: &'a str,
        options: &'a CreateInviteCodeOptions,
    ) -> StorageFuture<'a, InviteCode> {
        Box::pin(async move {
            self.creates.fetch_add(1, Ordering::SeqCst);

            let gate = self
                .create_gate
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();

            if let Some(gate) = gate {
                let _ = gate.acquire().await;
            }

            let row = InviteCodeRow {
                options: options.clone(),
                claimed_by: None,
                remaining_uses: match options.remaining_uses {
                    FieldUpdate::Set(uses) => Some(uses),
                    FieldUpdate::Absent | FieldUpdate::Clear => None,
                },
            };
            let invite = row.code(code);

            if self
                .codes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(code.to_owned(), row)
                .is_some()
            {
                return Err(StorageError::InvalidArgument {
                    message: "in-memory double: duplicate invite code",
                });
            }

            Ok(invite)
        })
    }

    fn find_by_code<'a>(&'a self, code: &'a str) -> StorageFuture<'a, Option<InviteCode>> {
        Box::pin(async move {
            Ok(self
                .codes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(code)
                .map(|row| row.code(code)))
        })
    }

    /// One use of the code, refused when it is absent, expired, claimed by someone else, or
    /// out of uses (`claimCode`, `src/repositories/invite-code-repository.ts`).
    fn claim_code<'a>(&'a self, code: &'a str, pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async move {
            self.claims
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((code.to_owned(), *pubkey));

            if self.fail_claims.load(Ordering::SeqCst) {
                return Err(StorageError::InvalidArgument {
                    message: "in-memory double: the claim failed",
                });
            }

            let mut codes = self
                .codes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(row) = codes.get_mut(code) else {
                return Ok(false);
            };

            if row
                .claimed_by
                .is_some_and(|claimed_by| claimed_by != *pubkey)
            {
                return Ok(false);
            }

            if row
                .options
                .expires_at
                .is_some_and(|expires_at| expires_at <= chrono::Utc::now())
            {
                return Ok(false);
            }

            if let Some(remaining) = row.remaining_uses {
                if remaining <= 0 {
                    return Ok(false);
                }

                row.remaining_uses = Some(remaining - 1);
            }

            row.claimed_by = Some(*pubkey);

            Ok(true)
        })
    }

    fn find_active_codes<'a>(&'a self, _limit: u64) -> StorageFuture<'a, Vec<InviteCode>> {
        Box::pin(async move { Ok(Vec::new()) })
    }

    fn delete_expired_codes<'a>(&'a self) -> StorageFuture<'a, u64> {
        Box::pin(async move { Ok(0) })
    }
}

/// A DVM job repository that records every job it is asked to create.
#[derive(Debug, Default)]
pub struct InMemoryDvmJobRepository {
    jobs: Mutex<Vec<DvmJob>>,
    fail_writes: AtomicBool,
}

impl InMemoryDvmJobRepository {
    /// An empty store.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The jobs recorded, in creation order.
    pub fn jobs(&self) -> Vec<DvmJob> {
        self.jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Makes every write fail, as an unavailable database would.
    pub fn fail_writes(&self) {
        self.fail_writes.store(true, Ordering::SeqCst);
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
            if self.fail_writes.load(Ordering::SeqCst) {
                return Err(StorageError::InvalidArgument {
                    message: "in-memory double: the dvm job write failed",
                });
            }

            let now = chrono::Utc::now();
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

/// A report repository with one settable actionable-target snapshot, which also records the
/// rows it is asked to write.
#[derive(Debug, Default)]
pub struct InMemoryReportRepository {
    targets: Mutex<Vec<ActionableTarget>>,
    queries: AtomicU64,
    fail_queries: AtomicBool,
    writes: Mutex<Vec<Vec<NewReport>>>,
    fail_writes: AtomicBool,
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

    /// The report rows each write was asked for, one entry per call.
    pub fn report_writes(&self) -> Vec<Vec<NewReport>> {
        self.writes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Every report row written, in call order.
    pub fn reports(&self) -> Vec<NewReport> {
        self.report_writes().into_iter().flatten().collect()
    }

    /// Makes every report write fail, as an unavailable database would.
    pub fn fail_writes(&self) {
        self.fail_writes.store(true, Ordering::SeqCst);
    }
}

impl ReportRepository for InMemoryReportRepository {
    fn create<'a>(&'a self, report: &'a NewReport) -> StorageFuture<'a, Report> {
        Box::pin(async move {
            if self.fail_writes.load(Ordering::SeqCst) {
                return Err(StorageError::InvalidArgument {
                    message: "in-memory double: the report write failed",
                });
            }

            let mut writes = self
                .writes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            writes.push(vec![report.clone()]);

            Ok(stored_report(written_rows(&writes), report))
        })
    }

    /// One insert of the whole batch, in input order — one row per input.
    fn create_many<'a>(&'a self, batch: &'a [NewReport]) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async move {
            if self.fail_writes.load(Ordering::SeqCst) {
                return Err(StorageError::InvalidArgument {
                    message: "in-memory double: the report write failed",
                });
            }

            let mut writes = self
                .writes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            writes.push(batch.to_vec());

            let first = written_rows(&writes) - batch.len() as i32;
            let rows = batch
                .iter()
                .enumerate()
                .map(|(index, report)| stored_report(first + index as i32 + 1, report))
                .collect();

            Ok(rows)
        })
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

/// How many report rows the recorded writes hold.
fn written_rows(writes: &[Vec<NewReport>]) -> i32 {
    writes.iter().map(|write| write.len() as i32).sum()
}

/// The row a report write answers with: the input's fields, a synthesised id.
fn stored_report(id: i32, report: &NewReport) -> Report {
    Report {
        id,
        event_id: report.event_id,
        reporter_pubkey: report.reporter_pubkey,
        reported_pubkey: report.reported_pubkey,
        reported_event_id: report.reported_event_id,
        report_type: report.report_type,
        weight: report.weight,
        actionable: report.actionable,
        created_at: chrono::Utc::now(),
    }
}

/// A trust graph that records every call, so a test can assert which strategy reached it and
/// with what.
#[derive(Debug, Default)]
pub struct RecordingWotGraph {
    follow_updates: Mutex<Vec<(Pubkey, Vec<String>)>>,
    distance_queries: Mutex<Vec<Pubkey>>,
    distance: Mutex<Option<u32>>,
    fail_updates: AtomicBool,
    fail_distances: AtomicBool,
}

impl RecordingWotGraph {
    /// An empty graph: every pubkey is outside it.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The hop distance every query answers; `None` means "outside the graph".
    pub fn set_distance(&self, distance: Option<u32>) {
        *self
            .distance
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = distance;
    }

    /// The `(pubkey, follows)` each `update_follow_list` was called with.
    pub fn follow_updates(&self) -> Vec<(Pubkey, Vec<String>)> {
        self.follow_updates
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The pubkey each `get_distance` was called with.
    pub fn distance_queries(&self) -> Vec<Pubkey> {
        self.distance_queries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Makes every `update_follow_list` fail.
    pub fn fail_updates(&self) {
        self.fail_updates.store(true, Ordering::SeqCst);
    }

    /// Makes every `get_distance` fail.
    pub fn fail_distances(&self) {
        self.fail_distances.store(true, Ordering::SeqCst);
    }
}

impl WotGraph for RecordingWotGraph {
    fn update_follow_list<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        follows: &'a [String],
    ) -> WotFuture<'a, ()> {
        Box::pin(async move {
            self.follow_updates
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((*pubkey, follows.to_vec()));

            if self.fail_updates.load(Ordering::SeqCst) {
                return Err(RelayError::Storage(StorageError::InvalidArgument {
                    message: "in-memory double: the wot graph update failed",
                }));
            }

            Ok(())
        })
    }

    fn get_distance<'a>(&'a self, pubkey: &'a Pubkey) -> WotFuture<'a, Option<u32>> {
        Box::pin(async move {
            self.distance_queries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(*pubkey);

            if self.fail_distances.load(Ordering::SeqCst) {
                return Err(RelayError::Storage(StorageError::InvalidArgument {
                    message: "in-memory double: the wot graph query failed",
                }));
            }

            Ok(*self
                .distance
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()))
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

/// The six doubles and the trust-graph recorder as one [`Stores`] value.
pub fn stores(
    events: Arc<InMemoryEventRepository>,
    users: Arc<InMemoryUserRepository>,
    nip05: Arc<InMemoryNip05Repository>,
    invites: Arc<InMemoryInviteCodeRepository>,
    reports: Arc<InMemoryReportRepository>,
    dvm: Arc<InMemoryDvmJobRepository>,
    wot: Arc<RecordingWotGraph>,
) -> Arc<Stores> {
    Arc::new(Stores {
        events,
        users,
        nip05,
        invites,
        dvm_jobs: dvm,
        reports,
        wot,
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
    pub dvm: Arc<InMemoryDvmJobRepository>,
    pub wot: Arc<RecordingWotGraph>,
    pub hidden: Arc<HiddenContentCache>,
    pub hub: tokio::sync::broadcast::Sender<std::sync::Arc<Event>>,
}

impl Fixture {
    /// A fixture over fresh, empty doubles.
    pub fn new(settings: Settings) -> Self {
        let events = InMemoryEventRepository::new();
        let users = InMemoryUserRepository::new();
        let nip05 = InMemoryNip05Repository::new();
        let invites = InMemoryInviteCodeRepository::new();
        let reports = InMemoryReportRepository::new();
        let dvm = InMemoryDvmJobRepository::new();
        let wot = RecordingWotGraph::new();
        let (hub, _receiver) = tokio::sync::broadcast::channel(64);

        Self {
            settings: Arc::new(settings),
            stores: stores(
                Arc::clone(&events),
                Arc::clone(&users),
                Arc::clone(&nip05),
                Arc::clone(&invites),
                Arc::clone(&reports),
                Arc::clone(&dvm),
                Arc::clone(&wot),
            ),
            events,
            users,
            nip05,
            invites,
            reports,
            dvm,
            wot,
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
    hub: &tokio::sync::broadcast::Sender<std::sync::Arc<Event>>,
) -> tokio::sync::broadcast::Receiver<std::sync::Arc<Event>> {
    hub.subscribe()
}
