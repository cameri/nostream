//! The nine repository traits and the rows they move. Mirrors `src/@types/repositories.ts`
//! and the `src/@types/*` domain types at the capture commit.
//!
//! Every method is declared here and implemented in `crate::records` (constructors, enum
//! spellings, conversions) or `crate::postgres` (the backend), so the method count is
//! greppable and no implementation hides in this file. The capture returns `IQueryResult`,
//! a thenable with `.stream()`; here the two query methods return [`QueryStream`], which
//! borrows the store for the stream's life.

use std::future::Future;
use std::pin::Pin;

use chrono::{DateTime, Utc};
use futures_core::Stream;
use nostream_core::{EventId, Kind, KindSelector, Pubkey, SettingsPubkey};

use crate::error::StorageError;

/// One boxed repository future. The lifetime is the borrow of the store, exactly as in
/// `src/@types/repositories.ts`, whose methods take the ambient `DatabaseClient`.
pub type StorageFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, StorageError>> + Send + 'a>>;

/// One item per page slot, in exactly the query's `ORDER BY`. The borrow of the store is held
/// for the stream's life, which is what both backends need: Postgres holds a portal and a
/// pooled connection, and LMDB holds whatever its own query kept, opening a short read
/// transaction per batch (256 values) so a dropped stream pins no pages. A filter read's item
/// is a [`StreamedEvent`], because a slot the backend selected may have no row to yield.
///
/// An LMDB backend's two streams keep different things, and a caller plans memory from the
/// difference: `find_by_filters` collects its page first — at most each filter's limit, clamped
/// to the backend's bound, so at most `MAX_PAGE_KEYS × filters` ids in all — and copies each
/// batch's values out of that page, so its memory is the page; `find_reconciliation_items`
/// keeps only a cursor key and re-seeks it per batch, so its result is never materialised —
/// except for an `ids` filter naming exact ids, whose own list, bounded by the request, is read
/// as one batch and sorted before it is emitted. A prefix criterion is a byte range over the id
/// field rather than the request's list, so it takes the bounded scan.
/// Neither is a snapshot: a row written or deleted between two batches may appear or vanish. A
/// channel would force a background task and a buffer policy LMDB does not need, and a `Vec`
/// would materialise a 10M-row NIP-77 reconciliation.
pub type QueryStream<'a, T> = Pin<Box<dyn Stream<Item = Result<T, StorageError>> + Send + 'a>>;

/// The rows a retention pass deleted, expired and kept (`src/@types/repositories.ts`
/// `EventPurgeCounts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EventPurgeCounts {
    pub deleted: u64,
    pub expired: u64,
    pub retained: u64,
}

/// The options a retention pass takes (`src/@types/repositories.ts` `EventRetentionOptions`).
///
/// `kind_whitelist` holds [`KindSelector`]s, not bare kinds: the capture's
/// `(EventKinds | EventKindsRange)[]` carries `[start, end]` ranges, which a `Vec<Kind>`
/// silently dropped.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EventRetentionOptions {
    pub max_days: Option<i64>,
    pub kind_whitelist: Option<Vec<KindSelector>>,
    pub pubkey_whitelist: Option<Vec<SettingsPubkey>>,
}

/// One stored event row: the seven wire fields plus the five columns that are storage
/// state rather than wire data (`src/@types/event.ts` `DBEvent`, and the two insert-time
/// Symbols in `src/constants/base.ts`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EventRecord {
    /// `events.id` (uuid, DB-generated). `None` on a write; the Postgres backend populates
    /// it on every read, while another backend may leave it `None` (it is backend-defined).
    pub row_id: Option<String>,
    /// The seven wire fields (`nostream_core::Event`), unchanged.
    pub event: nostream_core::Event,
    /// `events.first_seen` (DB default `now()`); `None` on a write.
    pub first_seen: Option<DateTime<Utc>>,
    /// `events.deleted_at`; soft-delete state, `None` on a write.
    pub deleted_at: Option<DateTime<Utc>>,
    /// `events.expires_at`, unix seconds (the insert-time NIP-40 metadata).
    pub expires_at: Option<i64>,
    /// `events.event_deduplication`, the jsonb array: `[pubkey, kind]` by default,
    /// `[d-tag]` for kinds 30000..=39999. `None` means "the capture's default".
    pub event_deduplication: Option<Vec<serde_json::Value>>,
    /// `events.remote_address` (the `ContextMetadataKey` insert metadata).
    pub remote_address: Option<std::net::IpAddr>,
}

/// One item of a filter read: the row for a page slot, or the marker for a slot the backend
/// selected and could not read.
///
/// The distinction exists because a `limit` read is a claim about a **count of slots**, and the
/// page obligation on [`EventRepository::find_by_filters`] is stated in rows. A backend that
/// enumerated a key and found it gone when it came to read the value has spent the slot without
/// a row; reporting that as "fewer rows" is indistinguishable at the call site from a short
/// result, which is how a false NIP-67 `finish` reaches the wire. [`StreamedEvent::Vanished`] is
/// the backend saying so, and the relay counts it as a spent slot.
// The row is the item, and it moves by value exactly as it did inside `Result<EventRecord, _>`
// before the marker existed; boxing it would add one allocation per streamed row to the read
// path to make a two-variant enum smaller than the rows it carries.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq)]
pub enum StreamedEvent {
    /// One stored row, as the query ordered it.
    Record(EventRecord),
    /// The backend selected this slot and then could not read it: the key was in the page when
    /// the backend enumerated it and gone when the backend read its value.
    Vanished,
}

/// Drains a filter read into the rows it yielded, dropping [`StreamedEvent::Vanished`].
///
/// This is the helper for every call site that does not account for vanished slots: the marker
/// is a fact about the page, not a row, so a consumer that only wants rows cannot inherit it.
pub fn collect_records<'a>(
    mut stream: QueryStream<'a, StreamedEvent>,
) -> StorageFuture<'a, Vec<EventRecord>> {
    Box::pin(async move {
        let mut records = Vec::new();
        while let Some(item) =
            std::future::poll_fn(|context| stream.as_mut().poll_next(context)).await
        {
            if let StreamedEvent::Record(record) = item? {
                records.push(record);
            }
        }
        Ok(records)
    })
}

/// One NIP-77 reconciliation item (`src/@types/repositories.ts` `ReconciliationItem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciliationItem {
    pub created_at: i64,
    pub event_id: EventId,
}

/// One user row (`src/@types/user.ts` `User`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct User {
    pub pubkey: Pubkey,
    pub is_admitted: bool,
    pub is_vanished: bool,
    /// TS `bigint` over a PG `int8`.
    pub balance: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    // Deliberately no `tos_accepted_at`: the capture's `fromDBUser` omits it
    // (`src/utils/transform.ts:137-144`). Writes carry it in [`UserPatch`].
}

/// The user fields a write carries (`src/repositories/user-repository.ts` `upsert`).
///
/// Each flag follows [`FieldUpdate`]: `Absent` leaves the column alone, which is what an
/// upsert that only needs the row to exist sends. Writing `false` unconditionally would clear
/// an admitted user's admission every time they created an invoice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserPatch {
    pub pubkey: Pubkey,
    /// `Absent` leaves the column alone; a new row is written `false`.
    pub is_admitted: FieldUpdate<bool>,
    /// `Absent` leaves the column alone; a new row is written `false`.
    pub is_vanished: FieldUpdate<bool>,
    /// Absent = leave the column alone (knex skips `undefined`); `Clear` = NULL;
    /// `Set(t)` = t (the capture passes `null` explicitly to clear).
    pub tos_accepted_at: FieldUpdate<DateTime<Utc>>,
}

/// `invoices.unit` (`src/@types/invoice.ts` `InvoiceUnit`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InvoiceUnit {
    Msats,
    Sats,
    Btc,
}

/// `invoices.status` (`src/@types/invoice.ts` `InvoiceStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InvoiceStatus {
    Pending,
    Completed,
    Expired,
}

/// One payment invoice row (`src/@types/invoice.ts` `Invoice`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Invoice {
    pub id: String,
    pub pubkey: Pubkey,
    pub bolt11: String,
    pub amount_requested: i64,
    pub amount_paid: Option<i64>,
    pub unit: InvoiceUnit,
    pub status: InvoiceStatus,
    pub description: String,
    pub confirmed_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub verify_url: Option<String>,
}

/// One NIP-05 verification row (`src/@types/nip05.ts` `Nip05Verification`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Nip05Verification {
    pub pubkey: Pubkey,
    pub nip05: String,
    pub domain: String,
    pub is_verified: bool,
    pub last_verified_at: Option<DateTime<Utc>>,
    pub last_checked_at: DateTime<Utc>,
    pub failure_count: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// The options a minted invite code takes (`src/@types/invite-code.ts`
/// `CreateInviteCodeOptions`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateInviteCodeOptions {
    pub expires_at: Option<DateTime<Utc>>,
    /// Absent = the capture's default of one use; `Clear` = unlimited; `Set(n)` = n.
    pub remaining_uses: FieldUpdate<i32>,
    pub created_by: Option<Pubkey>,
}

/// One invite code (`src/@types/invite-code.ts` `InviteCode`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct InviteCode {
    pub code: String,
    pub created_by: Option<Pubkey>,
    pub claimed_by: Option<Pubkey>,
    pub expires_at: Option<DateTime<Utc>>,
    pub remaining_uses: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// `dvm_jobs.status` (`src/@types/dvm.ts` `DvmJobStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DvmJobStatus {
    Submitted,
    PickedUp,
    Completed,
    Failed,
    TimedOut,
}

/// One DVM job row (`src/@types/dvm.ts` `DvmJob`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DvmJob {
    pub id: EventId,
    pub requester_pubkey: Pubkey,
    pub kind: Kind,
    pub worker_index: Option<i32>,
    pub status: DvmJobStatus,
    pub result_event_id: Option<EventId>,
    pub error: Option<String>,
    pub picked_up_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Key presence, which the capture checks with `'resultEventId' in job`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldUpdate<T> {
    Absent,
    Clear,
    Set(T),
}

impl<T> FieldUpdate<T> {
    /// The value the update writes, when it writes one.
    pub fn value(&self) -> Option<&T> {
        match self {
            Self::Set(value) => Some(value),
            Self::Absent | Self::Clear => None,
        }
    }
}

/// One DVM status update (`src/repositories/dvm-job-repository.ts` `updateStatus`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DvmJobUpdate {
    pub id: EventId,
    pub status: DvmJobStatus,
    pub result_event_id: FieldUpdate<EventId>,
    pub error: FieldUpdate<String>,
}

/// `reports.report_type` (`src/@types/report.ts` `ReportType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportType {
    Nudity,
    Malware,
    Profanity,
    Illegal,
    Spam,
    Impersonation,
    Other,
}

/// The fields a report write carries (`src/@types/report.ts`, minus `id`/`createdAt`).
#[derive(Debug, Clone, PartialEq)]
pub struct NewReport {
    pub event_id: EventId,
    pub reporter_pubkey: Pubkey,
    pub reported_pubkey: Option<Pubkey>,
    pub reported_event_id: Option<EventId>,
    pub report_type: ReportType,
    /// `real` in the schema (knex `float`), so `f32`.
    pub weight: f32,
    pub actionable: bool,
}

/// One report row (`src/@types/report.ts` `Report`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Report {
    pub id: i32,
    pub event_id: EventId,
    pub reporter_pubkey: Pubkey,
    pub reported_pubkey: Option<Pubkey>,
    pub reported_event_id: Option<EventId>,
    pub report_type: ReportType,
    pub weight: f32,
    pub actionable: bool,
    pub created_at: DateTime<Utc>,
}

/// One actionable report target (`src/@types/repositories.ts` `findActionableTargets`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionableTarget {
    pub reported_pubkey: Option<Pubkey>,
    pub reported_event_id: Option<EventId>,
}

/// `notification_delivery_log.target_type` (`src/@types/operator-notifications.ts`
/// `OperatorNotificationChannelType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationTargetType {
    Http,
    Discord,
    Slack,
    Telegram,
}

/// `notification_delivery_log.status` (`src/@types/operator-notifications.ts`
/// `NotificationDeliveryStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationDeliveryStatus {
    Success,
    Failed,
}

/// One delivery attempt to append (`src/@types/operator-notifications.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewDeliveryLogEntry {
    pub outbox_id: Option<String>,
    pub event_type: String,
    pub target_id: String,
    pub target_type: NotificationTargetType,
    pub status: NotificationDeliveryStatus,
    pub attempt_number: i32,
    pub error_snippet: Option<String>,
}

/// One stored delivery attempt (`src/@types/operator-notifications.ts`
/// `NotificationDeliveryLogEntry`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeliveryLogEntry {
    pub id: String,
    pub outbox_id: Option<String>,
    pub event_type: String,
    pub target_id: String,
    pub target_type: NotificationTargetType,
    pub status: NotificationDeliveryStatus,
    pub attempt_number: i32,
    pub error_snippet: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// The filters `findRecent` accepts (no filters by default).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeliveryLogFilters {
    pub status: Option<NotificationDeliveryStatus>,
    pub event_type: Option<String>,
}

/// `notification_outbox.status` (`src/@types/notification-outbox.ts`
/// `NotificationOutboxStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutboxStatus {
    Pending,
    Processing,
    Delivered,
    Dead,
}

/// The JSON document an outbox message carries.
pub type OutboxPayload = serde_json::Value;

/// One outbox message (`src/@types/notification-outbox.ts`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct OutboxMessage {
    pub id: String,
    pub event_type: String,
    pub payload: OutboxPayload,
    pub status: OutboxStatus,
    pub attempt_count: i32,
    pub available_at: DateTime<Utc>,
    pub last_error: Option<String>,
    pub delivered_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// How long a `processing` row is left alone before another worker may reclaim it
/// (`src/repositories/notification-outbox-repository.ts`).
pub const NOTIFICATION_OUTBOX_PROCESSING_LEASE_MS: i64 = 5 * 60 * 1000;

/// The matching rule a backend applies to a filter that carries `search` (NIP-50).
///
/// A completeness claim is a claim about the set a backend *enumerated*, so the caller has to
/// know what that backend's `search` predicate actually does. Saying only "my predicate may
/// differ" would let the next backend tick a box; each variant names the rule, so an implementor
/// has to read what it is asserting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchRule {
    /// Exactly [`nostream_core::Filter::matches`]: every whitespace-separated term of `search`
    /// must appear as a lowercase **substring** of the content. The backend enumerates with the
    /// relay's own matcher, so a completeness claim over such a read is one the relay can check.
    SubstringTerms,
    /// Postgres' prefilter: `to_tsvector(<language>, content) @@ plainto_tsquery(<language>,
    /// query)`. Word **tokens**, stemmed by the `language` regconfig — not substrings, and not
    /// the relay's rule. The two predicates contain neither the other:
    ///
    /// - the query `study` selects a row whose content is `studies` (both reduce to the one
    ///   English stem `studi`), and [`nostream_core::Filter::matches`] refuses it because
    ///   `"studies"` contains no `"study"`;
    /// - `abcdef` is a substring of the content `xxabcdefyy`, which `Filter::matches` accepts and
    ///   the tsquery never yields, because that content is one token.
    ///
    /// The first is the direction a probe can see (a yielded row the relay refuses); the second
    /// is why no probe is enough, and why a caller withholds rather than checks.
    ToTsvector {
        /// The regconfig the predicate is evaluated under (`nip50.language`, `simple` by default).
        language: String,
    },
}

/// Whether a backend's tag index can answer a criterion that is the empty string.
///
/// [`nostream_core::Filter::matches`] compares a tag value to the criterion with `==`, so the
/// criterion `""` accepts a tag stored as `["d", ""]`. A backend that answers tag criteria from
/// an index of non-empty values holds no entry for the empty one, and then that criterion
/// selects nothing while the matcher would have accepted every such row — a short page that
/// proves nothing about the rows it never enumerated. Each variant names the rule, as
/// [`SearchRule`]'s do, so an implementor has to read what it is asserting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmptyTagRule {
    /// A criterion that is the empty string selects at least what
    /// [`nostream_core::Filter::matches`] selects: the implementor asserts its tag predicate
    /// accepts everything that matcher accepts on the tag criteria — a wider predicate accepts
    /// more, and cannot hide a row, because a yielded row the matcher refuses is what the caller
    /// reads as a failed claim.
    AnswersEmptyCriterion,
    /// The tag index holds no entry for an empty value, so the criterion `""` selects nothing
    /// however many rows carry `["d", ""]`. LMDB: `tag_entries` writes a key only when the value
    /// is non-empty (`crates/nostream-storage/src/lmdb/encoding.rs:387`). Postgres: the
    /// `event_tags` trigger inserts a row only where `tag_value <> ''`
    /// (`migrations/20240108130100_add_event_tags_table.sql:24`).
    IndexesNoEmptyValue,
}

/// Event storage (`src/@types/repositories.ts` `IEventRepository`).
pub trait EventRepository: Send + Sync {
    /// Inserts one event, returning the affected row count (0 on a duplicate `event_id`).
    fn create<'a>(&'a self, record: &'a EventRecord) -> StorageFuture<'a, u64>;

    /// Inserts every event, returning the affected row count.
    ///
    /// Atomicity is backend-defined: the Postgres backend sends one statement up to its bind
    /// limit and batches beyond it, so a mid-batch error can leave earlier batches written
    /// (ADR 0003, "Batching"). A caller that needs all-or-nothing for any size owns a
    /// transaction.
    fn create_many<'a>(&'a self, records: &'a [EventRecord]) -> StorageFuture<'a, u64>;

    /// Inserts or replaces a replaceable event, returning the affected row count.
    fn upsert<'a>(&'a self, record: &'a EventRecord) -> StorageFuture<'a, u64>;

    /// Inserts or replaces every event, returning the affected row count.
    ///
    /// The same backend-defined atomicity as [`EventRepository::create_many`]. `records` may
    /// hold several versions of one replaceable address: the implementation keeps one row per
    /// [`replacement_key`](crate::records::replacement_key) using
    /// [`replaces`](crate::records::replaces), so a caller does not have to, and the affected
    /// count is the number of rows written, not of records passed. A record of any other kind
    /// has no key and is written as it comes.
    fn upsert_many<'a>(&'a self, records: &'a [EventRecord]) -> StorageFuture<'a, u64>;

    /// Streams the events matching the filters, in the query's order.
    ///
    /// **The page obligation.** A NIP-67 `finish` hint claims that every stored event matching a
    /// subscription's filters has been sent, and the relay decides it by comparing the rows it
    /// received against `min(limit, page_bound())` — so this method carries a contract that has a
    /// direction in each half:
    ///
    /// - a backend **MUST** yield up to `min(limit, page_bound())` matching rows whenever that
    ///   many exist. Yielding *fewer* while more exist is indistinguishable, at the call site,
    ///   from a short result, and makes a false `finish` reach the wire;
    /// - a backend **MUST NOT** yield more than `min(limit, page_bound())` rows for one filter,
    ///   with one exception the relay itself asks for: its probe passes `limit + 1`, so a backend
    ///   honouring that filter yields up to `min(limit + 1, page_bound())`. Yielding more only
    ///   suppresses a hint the relay could have proved — the harmless direction, but it is still
    ///   a contract, because a caller sizes its buffers by it.
    ///
    /// A backend whose own page is smaller than [`MAX_PAGE_ROWS`](crate::MAX_PAGE_ROWS) declares it through
    /// [`EventRepository::page_bound`]; the relay then asks for no more than it will be given and
    /// emits no hint where it cannot prove one.
    ///
    /// **The marker.** A backend that cannot honour the page at read time — it selected a key and
    /// the key was gone when it came to read the value — **MUST** yield
    /// [`StreamedEvent::Vanished`] for that slot rather than skipping it. The obligation above
    /// forbids the silent short page; this names the signal that keeps it honest when a
    /// concurrent write removes a selected row. The slot is spent either way, so a caller that
    /// only wants rows reads them through [`collect_records`], which drops the marker.
    fn find_by_filters<'a>(
        &'a self,
        filters: &'a [nostream_core::Filter],
    ) -> StorageFuture<'a, QueryStream<'a, StreamedEvent>>;

    /// Counts the events matching the filters.
    fn count_by_filters<'a>(
        &'a self,
        filters: &'a [nostream_core::Filter],
    ) -> StorageFuture<'a, u64>;

    /// The largest page this backend will return for one filter, whatever `limit` it carries.
    ///
    /// Defaults to [`MAX_PAGE_ROWS`](crate::MAX_PAGE_ROWS), which both shipped backends satisfy. A backend that clamps
    /// lower overrides it: [`EventRepository::find_by_filters`]' obligation is stated in terms of
    /// this value, and a caller that must know whether a page was truncated compares the rows it
    /// received against `min(limit, page_bound())`. Overriding it is what keeps a smaller page
    /// from being read as a short result.
    fn page_bound(&self) -> u64 {
        crate::MAX_PAGE_ROWS
    }

    /// The matching rule this backend applies to a filter that carries `search` (NIP-50).
    ///
    /// Defaults to [`SearchRule::SubstringTerms`], which is what a backend that filters with
    /// [`nostream_core::Filter::matches`] applies — LMDB's filter path *is* that matcher. A
    /// backend whose own predicate answers the filter overrides this, and a caller that must
    /// claim completeness over such a read reads it rather than assuming the relay's matcher
    /// enumerated the set.
    fn search_rule(&self) -> SearchRule {
        SearchRule::SubstringTerms
    }

    /// Whether a tag criterion that is the empty string can be answered from this backend's tag
    /// index (see [`EmptyTagRule`]).
    ///
    /// Defaults to [`EmptyTagRule::AnswersEmptyCriterion`], which is what a backend whose tag
    /// predicate is [`nostream_core::Filter::matches`] on the tag criteria, or a wider one,
    /// answers. A backend that answers tag criteria from an index of non-empty values overrides
    /// this, and a caller that must claim completeness over such a read reads it rather than
    /// assuming the criterion enumerated the set.
    fn empty_tag_rule(&self) -> EmptyTagRule {
        EmptyTagRule::AnswersEmptyCriterion
    }

    /// Streams the live `(created_at, event_id)` pairs a NIP-77 reconciliation compares.
    fn find_reconciliation_items<'a>(
        &'a self,
        filter: &'a nostream_core::Filter,
    ) -> StorageFuture<'a, QueryStream<'a, ReconciliationItem>>;

    /// Soft-deletes the given ids of one pubkey, returning the count.
    fn delete_by_pubkey_and_ids<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        ids: &'a [EventId],
    ) -> StorageFuture<'a, u64>;

    /// Soft-deletes the author's live addressable rows that these addresses name — each one's
    /// `d` identifier and kind, with `created_at` no later than `not_after` — returning the
    /// count. Kind 62 is never touched, as in
    /// [`delete_by_pubkey_and_ids`](Self::delete_by_pubkey_and_ids).
    ///
    /// **The caller checks the addresses are the author's to delete**: the pubkey and kind are
    /// taken as given, exactly as `delete_by_pubkey_and_ids` takes the ids it is given, and one
    /// address is one `(kind, d)` pair. The store's own guard is that every row it can reach is
    /// keyed by this pubkey.
    ///
    /// The whole batch is **one transaction**, which is why this is a batch rather than one call
    /// per address: a deletion request names its addresses in one event, and one event must not
    /// become N write transactions at the store.
    ///
    /// This exists as its own operation rather than as a read followed by
    /// `delete_by_pubkey_and_ids`, for two reasons a caller cannot work around: a read is
    /// bounded by the backend's page, so a narrow address must not be found by scanning a page;
    /// and a read and a delete are two operations, so a replacement landing between them
    /// survives the delete the client was told had happened. Both are properties of the store,
    /// so the store performs the resolution and the deletion as one.
    fn delete_by_addresses<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        addresses: &'a [(Kind, String)],
        not_after: i64,
    ) -> StorageFuture<'a, u64>;

    /// Soft-deletes every event of one pubkey except the given kinds.
    fn delete_by_pubkey_except_kinds<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        excluded_kinds: &'a [Kind],
    ) -> StorageFuture<'a, u64>;

    /// Whether the pubkey has a live kind-62 request to vanish.
    fn has_active_request_to_vanish<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, bool>;

    /// Hard-deletes one batch of expired, deleted and over-retention rows.
    fn delete_expired_and_retained<'a>(
        &'a self,
        options: &'a EventRetentionOptions,
    ) -> StorageFuture<'a, EventPurgeCounts>;
}

/// Invoice storage (`src/@types/repositories.ts` `IInvoiceRepository`).
pub trait InvoiceRepository: Send + Sync {
    /// Loads one invoice by id.
    fn find_by_id<'a>(&'a self, id: &'a str) -> StorageFuture<'a, Option<Invoice>>;

    /// Inserts an invoice or updates its status, returning the row count.
    fn upsert<'a>(&'a self, invoice: &'a Invoice) -> StorageFuture<'a, u64>;

    /// Updates one invoice's status and returns the row, `None` when no row matched.
    fn update_status<'a>(
        &'a self,
        id: &'a str,
        status: InvoiceStatus,
    ) -> StorageFuture<'a, Option<Invoice>>;

    /// Confirms a payment through the schema's `confirm_invoice` function.
    fn confirm_invoice<'a>(
        &'a self,
        invoice_id: &'a str,
        amount_received: i64,
        confirmed_at: DateTime<Utc>,
    ) -> StorageFuture<'a, ()>;

    /// Loads pending invoices, oldest first.
    fn find_pending_invoices<'a>(
        &'a self,
        offset: u64,
        limit: u64,
    ) -> StorageFuture<'a, Vec<Invoice>>;
}

/// User and admission storage (`src/@types/repositories.ts` `IUserRepository`).
pub trait UserRepository: Send + Sync {
    /// Loads one user by pubkey.
    fn find_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, Option<User>>;

    /// Inserts or updates one user, returning the row count.
    fn upsert<'a>(&'a self, user: &'a UserPatch) -> StorageFuture<'a, u64>;

    /// Reads the balance of a pubkey, `0` when no row exists.
    fn get_balance_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, i64>;

    /// Whether the pubkey is vanished, hydrating the flag from events once.
    fn is_vanished<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, bool>;

    /// Writes the vanished flag, returning the row count.
    fn set_vanished<'a>(&'a self, pubkey: &'a Pubkey, vanished: bool) -> StorageFuture<'a, u64>;

    /// Admits a pubkey through the schema's `admit_user` function.
    fn admit_user<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        admitted_at: DateTime<Utc>,
    ) -> StorageFuture<'a, ()>;

    /// Revokes admission, returning the row count.
    fn revoke_admission<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, u64>;
}

/// NIP-05 verification storage (`src/@types/repositories.ts`
/// `INip05VerificationRepository`).
pub trait Nip05VerificationRepository: Send + Sync {
    /// Loads the verification record for a pubkey.
    fn find_by_pubkey<'a>(
        &'a self,
        pubkey: &'a Pubkey,
    ) -> StorageFuture<'a, Option<Nip05Verification>>;

    /// Inserts or updates a verification record, returning the row count.
    fn upsert<'a>(&'a self, verification: &'a Nip05Verification) -> StorageFuture<'a, u64>;

    /// Loads the verifications that are due for a check, oldest check first.
    fn find_pending_verifications<'a>(
        &'a self,
        update_frequency_ms: i64,
        max_failures: i32,
        limit: u64,
    ) -> StorageFuture<'a, Vec<Nip05Verification>>;

    /// Deletes the verification record of one pubkey, returning the row count.
    fn delete_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, u64>;
}

/// Invite-code storage (`src/@types/repositories.ts` `IInviteCodeRepository`).
pub trait InviteCodeRepository: Send + Sync {
    /// Mints an invite code with its options.
    fn create<'a>(
        &'a self,
        code: &'a str,
        options: &'a CreateInviteCodeOptions,
    ) -> StorageFuture<'a, InviteCode>;

    /// Loads one invite code.
    fn find_by_code<'a>(&'a self, code: &'a str) -> StorageFuture<'a, Option<InviteCode>>;

    /// Claims one use of a code, returning whether a row changed.
    fn claim_code<'a>(&'a self, code: &'a str, pubkey: &'a Pubkey) -> StorageFuture<'a, bool>;

    /// Loads the codes that are still claimable, newest first.
    fn find_active_codes<'a>(&'a self, limit: u64) -> StorageFuture<'a, Vec<InviteCode>>;

    /// Deletes expired codes, returning the count.
    fn delete_expired_codes<'a>(&'a self) -> StorageFuture<'a, u64>;
}

/// DVM job storage (`src/@types/repositories.ts` `IDvmJobRepository`).
pub trait DvmJobRepository: Send + Sync {
    /// Creates a job row for a NIP-90 request.
    fn create<'a>(
        &'a self,
        id: &'a EventId,
        requester: &'a Pubkey,
        kind: Kind,
    ) -> StorageFuture<'a, DvmJob>;

    /// Loads one job.
    fn find_by_id<'a>(&'a self, id: &'a EventId) -> StorageFuture<'a, Option<DvmJob>>;

    /// Assigns a worker to a submitted job, returning whether a row changed.
    fn assign_worker<'a>(&'a self, id: &'a EventId, worker_index: i32) -> StorageFuture<'a, bool>;

    /// Applies a status update and returns the updated row.
    fn update_status<'a>(&'a self, update: &'a DvmJobUpdate) -> StorageFuture<'a, Option<DvmJob>>;

    /// Loads the pending jobs, oldest first, optionally by kind.
    fn find_pending_jobs<'a>(
        &'a self,
        limit: u64,
        kinds: Option<&'a [Kind]>,
    ) -> StorageFuture<'a, Vec<DvmJob>>;
}

/// Report storage (`src/@types/repositories.ts` `IReportRepository`).
pub trait ReportRepository: Send + Sync {
    /// Creates one report row.
    fn create<'a>(&'a self, report: &'a NewReport) -> StorageFuture<'a, Report>;

    /// Creates every report in one transaction, in input order.
    fn create_many<'a>(&'a self, reports: &'a [NewReport]) -> StorageFuture<'a, Vec<Report>>;

    /// Loads the reports against one event.
    fn find_by_event_id<'a>(&'a self, event_id: &'a EventId) -> StorageFuture<'a, Vec<Report>>;

    /// Loads actionable reports, newest first.
    fn find_actionable<'a>(&'a self, limit: u64) -> StorageFuture<'a, Vec<Report>>;

    /// Loads every distinct actionable report target.
    fn find_actionable_targets<'a>(&'a self) -> StorageFuture<'a, Vec<ActionableTarget>>;
}

/// Notification delivery-log storage (`src/@types/repositories.ts`
/// `INotificationDeliveryLogRepository`).
pub trait NotificationDeliveryLogRepository: Send + Sync {
    /// Appends one delivery attempt.
    fn append<'a>(&'a self, entry: &'a NewDeliveryLogEntry) -> StorageFuture<'a, ()>;

    /// Loads the recent log, newest first, optionally filtered.
    fn find_recent<'a>(
        &'a self,
        limit: u64,
        filters: &'a DeliveryLogFilters,
    ) -> StorageFuture<'a, Vec<DeliveryLogEntry>>;

    /// Loads the distinct target ids that succeeded for one outbox message.
    fn find_successful_target_ids<'a>(
        &'a self,
        outbox_id: &'a str,
    ) -> StorageFuture<'a, Vec<String>>;

    /// Deletes entries older than the cutoff, returning the count.
    fn delete_older_than<'a>(&'a self, cutoff: DateTime<Utc>) -> StorageFuture<'a, u64>;
}

/// Notification outbox storage (`src/@types/repositories.ts`
/// `INotificationOutboxRepository`).
pub trait NotificationOutboxRepository: Send + Sync {
    /// Enqueues one notification for delivery.
    fn enqueue<'a>(
        &'a self,
        event_type: &'a str,
        payload: &'a OutboxPayload,
    ) -> StorageFuture<'a, OutboxMessage>;

    /// Claims a batch for delivery, oldest first.
    fn claim_batch<'a>(&'a self, limit: u64) -> StorageFuture<'a, Vec<OutboxMessage>>;

    /// Marks a message delivered.
    fn mark_delivered<'a>(&'a self, id: &'a str) -> StorageFuture<'a, ()>;

    /// Marks a failed attempt, scheduling a retry or the dead transition.
    fn mark_failed<'a>(
        &'a self,
        id: &'a str,
        error: &'a str,
        attempt_count: i32,
        max_attempts: i32,
        base_delay_ms: i64,
    ) -> StorageFuture<'a, ()>;

    /// Deletes delivered and dead messages older than the cutoff.
    fn delete_terminal_older_than<'a>(&'a self, cutoff: DateTime<Utc>) -> StorageFuture<'a, u64>;
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use std::pin::Pin;
    use std::task::{Context, Poll};

    use futures_core::Stream;
    use nostream_core::{Event, EventId, Kind, Pubkey, Signature};

    use super::*;

    /// A stream of the items it was built from.
    struct Items(std::vec::IntoIter<Result<StreamedEvent, StorageError>>);

    impl Stream for Items {
        type Item = Result<StreamedEvent, StorageError>;

        fn poll_next(
            mut self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Option<Self::Item>> {
            Poll::Ready(self.0.next())
        }
    }

    /// A kind-1 row whose content is `content`.
    fn record(content: &str) -> EventRecord {
        EventRecord::from_event(&Event {
            id: EventId::from_byte_array([content.len() as u8; 32]),
            pubkey: Pubkey::from_byte_array([0; 32]),
            created_at: 1_700_000_000,
            kind: Kind(1),
            tags: Vec::new(),
            content: content.to_owned(),
            sig: Signature::from_byte_array([0; 64]),
        })
    }

    /// The helper hands a consumer only rows: the vanished slot is dropped, and the rows keep
    /// the page's order, so the marker cannot be read as if it were a record.
    #[tokio::test]
    async fn collect_records_drops_the_marker_and_keeps_every_row() {
        let items = vec![
            Ok(StreamedEvent::Record(record("one"))),
            Ok(StreamedEvent::Vanished),
            Ok(StreamedEvent::Record(record("two"))),
        ];
        let stream: QueryStream<'_, StreamedEvent> = Box::pin(Items(items.into_iter()));

        let rows = collect_records(stream).await.expect("the read drains");
        let contents: Vec<&str> = rows
            .iter()
            .map(|row| row.event.content.as_str())
            .collect::<Vec<_>>();

        assert_eq!(contents, vec!["one", "two"]);
    }
}
