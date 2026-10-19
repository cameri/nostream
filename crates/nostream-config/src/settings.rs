//! The typed settings schema. Mirrors `src/@types/settings.ts` and
//! `src/@types/operator-notifications.ts` at the capture commit.
//!
//! Field names follow the YAML keys, not the TypeScript identifiers: sections carry
//! `camelCase` keys (`maxPayloadSize`, `feeSchedules`), `info.relay_url` and
//! `terms_of_service` are the snake_case exceptions, and the processor blocks spell
//! `baseURL` and `callbackBaseURL` with a capitalised acronym.
//!
//! Optional fields are `Option<T>` and are skipped when serializing, so a typed value
//! round-trips to the document it was parsed from. There is no `deny_unknown_fields` here:
//! rejecting unknown keys is the shape validator's job (`crate::validate`), and the typed
//! parse runs only after validation.

use nostream_core::{EventStoreBackend, Filter, KindSelector, Secret, SettingsPubkey};
use serde::{Deserialize, Serialize};

use crate::notifications::AdminNotificationsSettings;

/// The paths [`Settings`] declares as `f64`.
///
/// A serialized document cannot say which leaves are floats: [`serialize_js_number`] writes
/// an integral `f64` as the integer `50`, which is the right encoding and loses the type. The
/// loader's numeric walk needs the type to name the field a value does not fit, so every
/// `f64` in this module is listed here and a test walks the schema to keep the list complete.
pub const FLOAT_FIELDS: &[&str] = &[
    "limits.event.pow.targetEventsPerSecond",
    "limits.event.pow.wotThresholds[].difficultyFactor",
];

/// Serializes a JavaScript `number` as an integer when it is integral, so a document that
/// wrote `50` round-trips as `50` rather than `50.0`. YAML distinguishes the two even though
/// JavaScript does not.
fn serialize_js_number<S>(value: &f64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

/// `info` — the relay's NIP-11 identity (`src/@types/settings.ts` `Info`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Info {
    pub relay_url: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub pubkey: String,
    #[serde(rename = "self", skip_serializing_if = "Option::is_none")]
    pub self_: Option<String>,
    pub contact: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terms_of_service: Option<String>,
}

/// `network` (`src/@types/settings.ts` `Network`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_payload_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_ip_header: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trusted_proxies: Option<Vec<String>>,
}

/// One window of a rate limiter (`src/@types/settings.ts` `RateLimit`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RateLimit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub period: u64,
    pub rate: u64,
}

/// The rate-limiter strategy (`src/@types/settings.ts` `RateLimiterSettings`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RateLimiterStrategy {
    Ewma,
    SlidingWindow,
}

/// The `limits.rateLimiter` block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RateLimiterSettings {
    pub strategy: RateLimiterStrategy,
}

/// `limits.event.eventId` (`src/@types/settings.ts` `EventIdLimits`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventIdLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_leading_zero_bits: Option<u32>,
}

/// `limits.event.pubkey` (`src/@types/settings.ts` `PubkeyLimits`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PubkeyLimits {
    /// `bigint` in the capture; `i64` in the rewrite (spec D15).
    pub min_balance: i64,
    pub min_leading_zero_bits: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whitelist: Option<Vec<SettingsPubkey>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blacklist: Option<Vec<SettingsPubkey>>,
}

/// A rate limit with kind selectors (`src/@types/settings.ts` `EventRateLimit`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventRateLimit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<KindSelector>>,
    pub period: u64,
    pub rate: u64,
}

/// `limits.event.kind` (`src/@types/settings.ts` `KindLimits`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KindLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whitelist: Option<Vec<KindSelector>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blacklist: Option<Vec<KindSelector>>,
}

/// `limits.event.createdAt` (`src/@types/settings.ts` `CreatedAtLimits`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedAtLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_negative_delta: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_positive_delta: Option<i64>,
}

/// One content-length rule (`src/@types/settings.ts` `ContentLimits`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<KindSelector>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u64>,
}

/// `content` is one rule or a list of them (`ContentLimits | ContentLimits[]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ContentLimitsOrVec {
    One(ContentLimits),
    Many(Vec<ContentLimits>),
}

/// `limits.event.whitelists` (`src/@types/settings.ts` `EventWhitelists`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWhitelists {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pubkeys: Option<Vec<SettingsPubkey>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_addresses: Option<Vec<String>>,
}

/// `limits.event.retention.kind` (`src/@types/settings.ts` `EventRetentionKindLimits`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventRetentionKindLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whitelist: Option<Vec<KindSelector>>,
}

/// `limits.event.retention.pubkey` (`src/@types/settings.ts` `EventRetentionPubkeyLimits`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventRetentionPubkeyLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whitelist: Option<Vec<SettingsPubkey>>,
}

/// `limits.event.retention` (`src/@types/settings.ts` `EventRetentionLimits`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRetentionLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_days: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<EventRetentionKindLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pubkey: Option<EventRetentionPubkeyLimits>,
}

/// One WoT-distance difficulty reduction (`src/@types/settings.ts` `WotPowThreshold`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WotPowThreshold {
    pub max_distance: u32,
    #[serde(serialize_with = "serialize_js_number")]
    pub difficulty_factor: f64,
}

/// `limits.event.pow` (`src/@types/settings.ts` `AdaptivePowSettings`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdaptivePowSettings {
    pub enabled: bool,
    pub floor_bits: u32,
    pub ceiling_bits: u32,
    #[serde(serialize_with = "serialize_js_number")]
    pub target_events_per_second: f64,
    pub period_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wot_thresholds: Option<Vec<WotPowThreshold>>,
}

/// `limits.event` (`src/@types/settings.ts` `EventLimits`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<EventIdLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pubkey: Option<PubkeyLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<KindLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<CreatedAtLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<ContentLimitsOrVec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<Vec<EventRateLimit>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whitelists: Option<EventWhitelists>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retention: Option<EventRetentionLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pow: Option<AdaptivePowSettings>,
}

/// `limits.client.subscription` (`src/@types/settings.ts` `ClientSubscriptionLimits`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSubscriptionLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_subscriptions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_filters: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_filter_values: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_prefix_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_subscription_id_length: Option<u64>,
}

/// `limits.client` (`src/@types/settings.ts` `ClientLimits`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription: Option<ClientSubscriptionLimits>,
}

/// A message rate limit (`src/@types/settings.ts` `MessageRateLimit`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRateLimit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub message_type: Option<String>,
    pub period: u64,
    pub rate: u64,
}

/// `limits.message` (`src/@types/settings.ts` `MessageLimits`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<Vec<MessageRateLimit>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_whitelist: Option<Vec<String>>,
}

/// `limits.connection` (`src/@types/settings.ts` `ConnectionLimits`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLimits {
    pub rate_limits: Vec<RateLimit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_whitelist: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_blacklist: Option<Vec<String>>,
}

/// `limits.invoice` (`src/@types/settings.ts` `InvoiceLimits`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceLimits {
    pub rate_limits: Vec<RateLimit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_whitelist: Option<Vec<String>>,
}

/// `limits.admissionCheck` (`src/@types/settings.ts` `AdmissionCheckLimits`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionCheckLimits {
    pub rate_limits: Vec<RateLimit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_whitelist: Option<Vec<String>>,
}

/// `limits.invite` (`src/@types/settings.ts` `InviteLimits`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<Vec<RateLimit>>,
}

/// `limits.admin` (`src/@types/settings.ts` `AdminLimits`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<Vec<RateLimit>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_rate_limits: Option<Vec<RateLimit>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_whitelist: Option<Vec<String>>,
}

/// `limits` (`src/@types/settings.ts` `Limits`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limiter: Option<RateLimiterSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invoice: Option<InvoiceLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite: Option<InviteLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admission_check: Option<AdmissionCheckLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admin: Option<AdminLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<ConnectionLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<ClientLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<EventLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<MessageLimits>,
}

/// `workers` (`src/@types/settings.ts` `Worker`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Worker {
    pub count: u32,
}

/// `eventStore` (`src/@types/settings.ts` `EventStoreSettings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventStoreSettings {
    /// Read once at startup, so changing it needs a restart.
    pub backend: EventStoreBackend,
}

/// `payments.feeSchedules.*[].whitelists` (`src/@types/settings.ts` `FeeScheduleWhitelists`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeeScheduleWhitelists {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pubkeys: Option<Vec<SettingsPubkey>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_kinds: Option<Vec<KindSelector>>,
}

/// One fee schedule (`src/@types/settings.ts` `FeeSchedule`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeeSchedule {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `bigint` in the capture; `i64` in the rewrite (spec D15).
    pub amount: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whitelists: Option<FeeScheduleWhitelists>,
}

/// `payments.feeSchedules` (`src/@types/settings.ts` `FeeSchedules`).
///
/// `publication` is required in the capture's type but absent from the capture's own defaults,
/// so it is optional here: the shipped document is the schema the round-trip test pins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeeSchedules {
    pub admission: Vec<FeeSchedule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication: Option<Vec<FeeSchedule>>,
}

/// The payment processor key (`src/@types/settings.ts` `keyof PaymentsProcessors`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Processor {
    Lnurl,
    Zebedee,
    Lnbits,
    Nodeless,
    Opennode,
    Nwc,
}

/// `payments` (`src/@types/settings.ts` `Payments`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payments {
    pub enabled: bool,
    pub processor: Processor,
    pub fee_schedules: FeeSchedules,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invoice_expiry_seconds: Option<u64>,
}

/// `paymentsProcessors.lnurl` (`src/@types/settings.ts` `LnurlPaymentsProcessor`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LnurlPaymentsProcessor {
    #[serde(rename = "invoiceURL")]
    pub invoice_url: String,
}

/// `paymentsProcessors.zebedee` (`src/@types/settings.ts` `ZebedeePaymentsProcessor`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZebedeePaymentsProcessor {
    #[serde(rename = "baseURL")]
    pub base_url: String,
    #[serde(rename = "callbackBaseURL")]
    pub callback_base_url: String,
    pub ip_whitelist: Vec<String>,
}

/// `paymentsProcessors.nodeless` (`src/@types/settings.ts` `NodelessPaymentsProcessor`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodelessPaymentsProcessor {
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub store_id: String,
}

/// `paymentsProcessors.lnbits` (`src/@types/settings.ts` `LNbitsPaymentsProcessor`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LnbitsPaymentsProcessor {
    #[serde(rename = "baseURL")]
    pub base_url: String,
    #[serde(rename = "callbackBaseURL")]
    pub callback_base_url: String,
}

/// `paymentsProcessors.opennode` (`src/@types/settings.ts` `OpenNodePaymentsProcessor`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpennodePaymentsProcessor {
    #[serde(rename = "baseURL")]
    pub base_url: String,
    #[serde(rename = "callbackBaseURL")]
    pub callback_base_url: String,
}

/// `paymentsProcessors.nwc` (`src/@types/settings.ts` `NwcPaymentsProcessor`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NwcPaymentsProcessor {
    pub invoice_expiry_seconds: u64,
    pub reply_timeout_ms: u64,
}

/// `paymentsProcessors` (`src/@types/settings.ts` `PaymentsProcessors`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaymentsProcessors {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lnurl: Option<LnurlPaymentsProcessor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zebedee: Option<ZebedeePaymentsProcessor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lnbits: Option<LnbitsPaymentsProcessor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nodeless: Option<NodelessPaymentsProcessor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opennode: Option<OpennodePaymentsProcessor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nwc: Option<NwcPaymentsProcessor>,
}

/// A mirror whose events are replicated (`src/@types/settings.ts` `Mirror`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mirror {
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filters: Option<Vec<Filter>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<Secret>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<MirrorLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_admission_check: Option<bool>,
}

/// `mirroring.static[].limits` (`src/@types/settings.ts` inline `limits`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MirrorLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<EventLimits>,
}

/// `mirroring` (`src/@types/settings.ts` `Mirroring`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Mirroring {
    #[serde(rename = "static", skip_serializing_if = "Option::is_none")]
    pub static_: Option<Vec<Mirror>>,
}

/// One DVM worker (`src/@types/settings.ts` `DvmWorker`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DvmWorker {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// `dvm` (`src/@types/settings.ts` `Dvm`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dvm {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workers: Option<Vec<DvmWorker>>,
}

/// `nip05.mode` (`src/@types/settings.ts` `Nip05Mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Nip05Mode {
    Enabled,
    Passive,
    Disabled,
}

/// `nip45` (`src/@types/settings.ts` `Nip45Settings`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Nip45Settings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

/// `nip50` (`src/@types/settings.ts` `Nip50Settings`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Nip50Settings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_query_length: Option<u64>,
}

/// `nip66.timeouts` (`src/@types/settings.ts` `Nip66ProbeTimeouts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Nip66ProbeTimeouts {
    pub dns_ms: u64,
    pub tls_ms: u64,
    pub ws_rtt_ms: u64,
    pub nip11_ms: u64,
}

/// `nip66` (`src/@types/settings.ts` `Nip66Settings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Nip66Settings {
    pub enabled: bool,
    pub probe_interval_seconds: u64,
    pub timeouts: Nip66ProbeTimeouts,
    pub targets: Vec<String>,
    pub dns_cache_ttl_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geohash: Option<String>,
}

/// `nip05` (`src/@types/settings.ts` `Nip05Settings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Nip05Settings {
    pub mode: Nip05Mode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify_expiration: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify_update_frequency: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_consecutive_failures: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_whitelist: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_blacklist: Option<Vec<String>>,
}

/// `admin.nip98` (`src/@types/settings.ts` `AdminNip98Settings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminNip98Settings {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_pubkeys: Option<Vec<SettingsPubkey>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_skew_seconds: Option<i64>,
}

/// `admin` (`src/@types/settings.ts` `AdminSettings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminSettings {
    pub enabled: bool,
    /// Typed `Secret` so a `Debug` of the settings tree redacts it; the capture types it
    /// `string`, and serde's transparent passthrough keeps the document byte-identical.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_hash: Option<nostream_core::Secret>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ttl_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nip98: Option<AdminNip98Settings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notifications: Option<AdminNotificationsSettings>,
}

/// `wot` (`src/@types/settings.ts` `WoTSettings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WotSettings {
    pub enabled: bool,
    pub seed_pubkey: SettingsPubkey,
    pub minimum_followers: u32,
    pub max_depth: u32,
    pub refresh_interval_hours: u64,
}

/// `nip42.restrictedReads` (`src/@types/settings.ts` `Nip42RestrictedReads`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Nip42RestrictedReads {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<KindSelector>>,
}

/// `nip42` (`src/@types/settings.ts` `Nip42Settings`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Nip42Settings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_expiry_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restricted_reads: Option<Nip42RestrictedReads>,
}

/// `nip43` (`src/@types/settings.ts` `Nip43Settings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Nip43Settings {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_code_expiry_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_max_uses: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_invite_requests: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_request_whitelist: Option<Vec<SettingsPubkey>>,
}

/// `nip56` (`src/@types/settings.ts` `Nip56Settings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Nip56Settings {
    pub enabled: bool,
    pub trusted_moderators: Vec<SettingsPubkey>,
    pub hide_actionable_reports: bool,
}

/// The root settings document (`src/@types/settings.ts` `Settings`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub info: Info,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admin: Option<AdminSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payments: Option<Payments>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payments_processors: Option<PaymentsProcessors>,
    pub network: Network,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workers: Option<Worker>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_store: Option<EventStoreSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<Limits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mirroring: Option<Mirroring>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dvm: Option<Dvm>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nip05: Option<Nip05Settings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nip42: Option<Nip42Settings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nip43: Option<Nip43Settings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nip45: Option<Nip45Settings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nip50: Option<Nip50Settings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nip56: Option<Nip56Settings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nip66: Option<Nip66Settings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wot: Option<WotSettings>,
}
