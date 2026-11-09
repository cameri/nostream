//! Helpers shared by the storage integration tests. A directory module, so cargo does not
//! build it as a target of its own.
//!
//! The executor below is the replay both parity targets share: it takes the nine repository
//! traits as `&dyn` references, so the same script drives Postgres and LMDB. It cannot reach
//! a serializable transaction or raw SQL, which is why the Postgres target keeps
//! `user.tos_accepted_at` and the `transaction` groups.

#![allow(dead_code)]

use std::collections::HashMap;
use std::future::poll_fn;

use chrono::{DateTime, Utc};
use nostream_config::Settings;
use serde_json::{Value, json};

use nostream_core::{Filter, Kind};
use nostream_storage::repositories::{
    ActionableTarget, CreateInviteCodeOptions, DeliveryLogEntry, DeliveryLogFilters, DvmJob,
    DvmJobRepository, DvmJobUpdate, EventPurgeCounts, EventRecord, EventRepository,
    EventRetentionOptions, FieldUpdate, InviteCode, InviteCodeRepository, Invoice,
    InvoiceRepository, InvoiceStatus, NewDeliveryLogEntry, NewReport, Nip05Verification,
    Nip05VerificationRepository, NotificationDeliveryLogRepository, NotificationOutboxRepository,
    OutboxMessage, QueryStream, ReconciliationItem, Report, ReportRepository, User, UserPatch,
    UserRepository, collect_records,
};

/// The nine repositories one replay calls, as the traits rather than a concrete backend.
#[derive(Clone, Copy)]
pub struct Repos<'a> {
    pub events: &'a dyn EventRepository,
    pub invoices: &'a dyn InvoiceRepository,
    pub users: &'a dyn UserRepository,
    pub nip05: &'a dyn Nip05VerificationRepository,
    pub invites: &'a dyn InviteCodeRepository,
    pub dvm: &'a dyn DvmJobRepository,
    pub reports: &'a dyn ReportRepository,
    pub delivery_log: &'a dyn NotificationDeliveryLogRepository,
    pub outbox: &'a dyn NotificationOutboxRepository,
}

impl<'a> Repos<'a> {
    /// The nine traits one backend implements.
    pub fn all<T>(backend: &'a T) -> Self
    where
        T: EventRepository
            + InvoiceRepository
            + UserRepository
            + Nip05VerificationRepository
            + InviteCodeRepository
            + DvmJobRepository
            + ReportRepository
            + NotificationDeliveryLogRepository
            + NotificationOutboxRepository,
    {
        Self {
            events: backend,
            invoices: backend,
            users: backend,
            nip05: backend,
            invites: backend,
            dvm: backend,
            reports: backend,
            delivery_log: backend,
            outbox: backend,
        }
    }
}

/// The capture's recording, compiled into the test binary.
pub fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/repository-parity.json"))
        .expect("tests/fixtures/repository-parity.json is valid JSON")
}

/// The shipped defaults with a fixture's overrides applied — the settings both the capture
/// and the replay load, so the gates under test are the fixture's. `PARITY_NIP50_LANGUAGE`,
/// when exported, replaces the fixture's language, which is how the plan guard sees a
/// deployment's language (ADR 0003, revisit trigger 4).
pub fn settings_from_fixture(fixture: &Value) -> Settings {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../resources/default-settings.yaml"
    ))
    .expect("the shipped defaults are readable");
    let mut document: serde_yaml::Value =
        serde_yaml::from_str(&raw).expect("the shipped defaults are valid YAML");
    if let Some(overrides) = fixture["settings"]["overrides"].as_object() {
        for (path, value) in overrides {
            let yaml = serde_yaml::to_value(value).expect("a YAML value");
            document = nostream_config::path::set_by_path(&document, path, yaml)
                .expect("the override path is writable");
        }
    }
    if let Ok(language) = std::env::var("PARITY_NIP50_LANGUAGE") {
        document = nostream_config::path::set_by_path(
            &document,
            "nip50.language",
            serde_yaml::Value::String(language),
        )
        .expect("nip50.language is writable");
    }
    serde_yaml::from_value(document).expect("the settings fit the typed schema")
}

// ---------------------------------------------------------------------------------------
// Encoders mirroring the generator.
// ---------------------------------------------------------------------------------------

pub fn iso(value: &DateTime<Utc>) -> Value {
    Value::String(value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

pub fn optional_iso(value: &Option<DateTime<Utc>>) -> Value {
    match value {
        Some(value) => iso(value),
        None => Value::Null,
    }
}

pub fn parse_iso(value: &Value) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value.as_str().expect("an ISO timestamp"))
        .expect("a valid ISO timestamp")
        .with_timezone(&Utc)
}

pub fn text(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is a string"))
        .to_owned()
}

pub fn integer(value: &Value, key: &str) -> i64 {
    value[key]
        .as_i64()
        .unwrap_or_else(|| panic!("{key} is an integer"))
}

pub fn optional_text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub fn text_of(value: &Value) -> String {
    value.as_str().expect("a string").to_owned()
}

pub fn event_row(record: &EventRecord) -> Value {
    json!([
        record.event.id.to_string(),
        record.event.created_at,
        record.expires_at,
        record.deleted_at.is_some(),
        record.event_deduplication,
    ])
}

pub fn event_record(value: &Value) -> EventRecord {
    let event: nostream_core::Event =
        serde_json::from_value(value["event"].clone()).expect("a wire event");
    let mut record = EventRecord::from_event(&event);
    if let Some(address) = optional_text(value, "remote_address") {
        record = record.with_remote_address(address.parse().expect("an IP address"));
    }
    if let Some(expires_at) = value.get("expires_at").and_then(Value::as_i64) {
        record = record.with_expires_at(expires_at);
    }
    if let Some(deduplication) = value.get("deduplication") {
        record = record.with_deduplication(
            serde_json::from_value(deduplication.clone()).expect("deduplication values"),
        );
    }
    record
}

pub fn invoice_view(invoice: &Invoice) -> Value {
    json!({
        "id": invoice.id,
        "pubkey": invoice.pubkey.to_string(),
        "bolt11": invoice.bolt11,
        "amount_requested": invoice.amount_requested,
        "amount_paid": invoice.amount_paid,
        "unit": invoice.unit.as_str(),
        "status": invoice.status.as_str(),
        "description": invoice.description,
        "confirmed_at": optional_iso(&invoice.confirmed_at),
        "expires_at": optional_iso(&invoice.expires_at),
        "verify_url": invoice.verify_url,
    })
}

pub fn optional_invoice_view(invoice: &Option<Invoice>) -> Value {
    match invoice {
        Some(invoice) => invoice_view(invoice),
        None => Value::Null,
    }
}

pub fn user_view(user: &User) -> Value {
    json!({
        "pubkey": user.pubkey.to_string(),
        "is_admitted": user.is_admitted,
        "is_vanished": user.is_vanished,
        "balance": user.balance,
    })
}

pub fn optional_user_view(user: &Option<User>) -> Value {
    match user {
        Some(user) => user_view(user),
        None => Value::Null,
    }
}

pub fn nip05_view(verification: &Nip05Verification) -> Value {
    json!({
        "pubkey": verification.pubkey.to_string(),
        "nip05": verification.nip05,
        "domain": verification.domain,
        "is_verified": verification.is_verified,
        "last_verified_at": optional_iso(&verification.last_verified_at),
        "last_checked_at": iso(&verification.last_checked_at),
        "failure_count": verification.failure_count,
    })
}

pub fn invite_view(invite: &InviteCode) -> Value {
    json!({
        "code": invite.code,
        "created_by": invite.created_by.map(|pubkey| pubkey.to_string()),
        "claimed_by": invite.claimed_by.map(|pubkey| pubkey.to_string()),
        "expires_at": optional_iso(&invite.expires_at),
        "remaining_uses": invite.remaining_uses,
    })
}

pub fn dvm_view(job: &DvmJob) -> Value {
    json!({
        "id": job.id.to_string(),
        "requester_pubkey": job.requester_pubkey.to_string(),
        "kind": job.kind.0,
        "worker_index": job.worker_index,
        "status": job.status.as_str(),
        "result_event_id": job.result_event_id.map(|id| id.to_string()),
        "error": job.error,
    })
}

pub fn optional_dvm_view(job: &Option<DvmJob>) -> Value {
    match job {
        Some(job) => dvm_view(job),
        None => Value::Null,
    }
}

pub fn report_view(report: &Report) -> Value {
    json!({
        "id": report.id,
        "event_id": report.event_id.to_string(),
        "reporter_pubkey": report.reporter_pubkey.to_string(),
        "reported_pubkey": report.reported_pubkey.map(|pubkey| pubkey.to_string()),
        "reported_event_id": report.reported_event_id.map(|id| id.to_string()),
        "report_type": report.report_type.as_str(),
        "weight": report.weight,
        "actionable": report.actionable,
    })
}

pub fn delivery_view(entry: &DeliveryLogEntry) -> Value {
    json!({
        "outbox_id": entry.outbox_id,
        "event_type": entry.event_type,
        "target_id": entry.target_id,
        "target_type": entry.target_type.as_str(),
        "status": entry.status.as_str(),
        "attempt_number": entry.attempt_number,
        "error_snippet": entry.error_snippet,
    })
}

pub fn outbox_view(message: &OutboxMessage) -> Value {
    json!({
        "event_type": message.event_type,
        "payload": message.payload,
        "status": message.status.as_str(),
        "attempt_count": message.attempt_count,
        "last_error": message.last_error,
    })
}

pub fn sort_by_key<T>(items: &mut [T], key: impl Fn(&T) -> String) {
    items.sort_by_key(|item| key(item));
}

pub async fn collect<T>(
    mut stream: QueryStream<'_, T>,
) -> Result<Vec<T>, nostream_storage::StorageError> {
    let mut items = Vec::new();
    while let Some(item) = poll_fn(|context| stream.as_mut().poll_next(context)).await {
        items.push(item?);
    }
    Ok(items)
}

fn field_update(value: &Value) -> FieldUpdate<Value> {
    match value["kind"].as_str().expect("a FieldUpdate kind") {
        "absent" => FieldUpdate::Absent,
        "clear" => FieldUpdate::Clear,
        _ => FieldUpdate::Set(value["value"].clone()),
    }
}

fn parse_event_id(value: &Value) -> nostream_core::EventId {
    value
        .as_str()
        .expect("an event id")
        .parse()
        .expect("a valid event id")
}

fn parse_pubkey(value: &Value) -> nostream_core::Pubkey {
    value
        .as_str()
        .expect("a pubkey")
        .parse()
        .expect("a valid pubkey")
}

fn resolve_ref(
    refs: &HashMap<String, String>,
    request: &Value,
) -> Result<String, nostream_storage::StorageError> {
    let event_type = request
        .get("enqueue_event_type")
        .or_else(|| request.get("outbox_id_from"))
        .and_then(Value::as_str)
        .expect("an enqueue reference");
    refs.get(event_type)
        .cloned()
        .ok_or(nostream_storage::StorageError::InvalidArgument {
            message: "no enqueued row to address",
        })
}

fn new_report(value: &Value) -> NewReport {
    NewReport {
        event_id: parse_event_id(&value["event_id"]),
        reporter_pubkey: parse_pubkey(&value["reporter_pubkey"]),
        reported_pubkey: optional_text(value, "reported_pubkey")
            .map(|pubkey| pubkey.parse().expect("a pubkey")),
        reported_event_id: optional_text(value, "reported_event_id")
            .map(|id| id.parse().expect("an event id")),
        report_type: value["report_type"]
            .as_str()
            .expect("a report type")
            .parse()
            .expect("a report type"),
        weight: value["weight"].as_f64().expect("a weight") as f32,
        actionable: value["actionable"].as_bool().expect("actionable"),
    }
}

/// One script entry, through the nine traits.
///
/// The two arms this executor cannot run are `user.tos_accepted_at` (raw SQL, no seam form)
/// and `transaction` (no transaction type on the LMDB seam); the Postgres target handles the
/// former, and each target's replay loop handles the latter.
pub async fn run_op(
    repos: Repos<'_>,
    op: &Value,
    refs: &mut HashMap<String, String>,
) -> Result<Value, nostream_storage::StorageError> {
    let name = op["op"].as_str().expect("an op name");
    let request = &op["request"];

    match name {
        "events.create" => {
            let record = event_record(&request["record"]);
            Ok(json!({ "count": repos.events.create(&record).await? }))
        }
        "events.create_many" => {
            let records: Vec<EventRecord> = request["records"]
                .as_array()
                .expect("records")
                .iter()
                .map(event_record)
                .collect();
            Ok(json!({ "count": repos.events.create_many(&records).await? }))
        }
        "events.upsert" => {
            let record = event_record(&request["record"]);
            Ok(json!({ "count": repos.events.upsert(&record).await? }))
        }
        "events.upsert_many" => {
            let records: Vec<EventRecord> = request["records"]
                .as_array()
                .expect("records")
                .iter()
                .map(event_record)
                .collect();
            Ok(json!({ "count": repos.events.upsert_many(&records).await? }))
        }
        "events.find_by_filters" => {
            let filters: Vec<Filter> = request["filters"]
                .as_array()
                .expect("filters")
                .iter()
                .map(|filter| serde_json::from_value(filter.clone()).expect("a filter"))
                .collect();
            if filters.is_empty() {
                let failed = repos.events.find_by_filters(&[]).await.is_err();
                return Ok(json!({ "error": failed }));
            }
            let rows = collect_records(repos.events.find_by_filters(&filters).await?).await?;
            Ok(json!({ "rows": rows.iter().map(event_row).collect::<Vec<_>>() }))
        }
        "events.count_by_filters" => {
            let filters: Vec<Filter> = request["filters"]
                .as_array()
                .expect("filters")
                .iter()
                .map(|filter| serde_json::from_value(filter.clone()).expect("a filter"))
                .collect();
            Ok(json!({ "count": repos.events.count_by_filters(&filters).await? }))
        }
        "events.find_reconciliation_items" => {
            let filter: Filter =
                serde_json::from_value(request["filter"].clone()).expect("a filter");
            let items = collect(repos.events.find_reconciliation_items(&filter).await?).await?;
            Ok(json!({
                "items": items.iter().map(|ReconciliationItem { created_at, event_id }| {
                    json!([created_at, event_id.to_string()])
                }).collect::<Vec<_>>()
            }))
        }
        "events.delete_by_pubkey_and_ids" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            let ids: Vec<nostream_core::EventId> = request["ids"]
                .as_array()
                .expect("ids")
                .iter()
                .map(parse_event_id)
                .collect();
            Ok(json!({ "count": repos.events.delete_by_pubkey_and_ids(&pubkey, &ids).await? }))
        }
        "events.delete_by_pubkey_except_kinds" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            let kinds: Vec<Kind> = request["kinds"]
                .as_array()
                .expect("kinds")
                .iter()
                .map(|kind| Kind(kind.as_u64().expect("a kind")))
                .collect();
            Ok(
                json!({ "count": repos.events.delete_by_pubkey_except_kinds(&pubkey, &kinds).await? }),
            )
        }
        "events.has_active_request_to_vanish" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            Ok(json!({ "value": repos.events.has_active_request_to_vanish(&pubkey).await? }))
        }
        "events.delete_expired_and_retained" => {
            let options = EventRetentionOptions {
                max_days: request["options"].get("max_days").and_then(Value::as_i64),
                kind_whitelist: request["options"]
                    .get("kind_whitelist")
                    .and_then(Value::as_array)
                    .map(|selectors| {
                        selectors
                            .iter()
                            .map(|selector| match selector {
                                Value::Array(range) => nostream_core::KindSelector::Range([
                                    Kind(range[0].as_u64().expect("a range start")),
                                    Kind(range[1].as_u64().expect("a range end")),
                                ]),
                                other => nostream_core::KindSelector::Single(Kind(
                                    other.as_u64().expect("a kind"),
                                )),
                            })
                            .collect()
                    }),
                pubkey_whitelist: request["options"]
                    .get("pubkey_whitelist")
                    .and_then(Value::as_array)
                    .map(|pubkeys| {
                        pubkeys
                            .iter()
                            .map(|pubkey| nostream_core::SettingsPubkey(text_of(pubkey)))
                            .collect()
                    }),
            };
            let EventPurgeCounts {
                deleted,
                expired,
                retained,
            } = repos.events.delete_expired_and_retained(&options).await?;
            Ok(json!({ "deleted": deleted, "expired": expired, "retained": retained }))
        }
        "user.find_by_pubkey" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            Ok(json!({ "user": optional_user_view(&repos.users.find_by_pubkey(&pubkey).await?) }))
        }
        "user.upsert" => {
            let patch = &request["patch"];
            let tos_accepted_at = match field_update(&patch["tos_accepted_at"]) {
                FieldUpdate::Absent => FieldUpdate::Absent,
                FieldUpdate::Clear => FieldUpdate::Clear,
                FieldUpdate::Set(value) => FieldUpdate::Set(parse_iso(&value)),
            };
            let user = UserPatch {
                pubkey: parse_pubkey(&patch["pubkey"]),
                is_admitted: FieldUpdate::Set(patch["is_admitted"].as_bool().expect("is_admitted")),
                is_vanished: FieldUpdate::Set(patch["is_vanished"].as_bool().expect("is_vanished")),
                tos_accepted_at,
            };
            Ok(json!({ "count": repos.users.upsert(&user).await? }))
        }
        "user.get_balance_by_pubkey" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            Ok(json!({ "balance": repos.users.get_balance_by_pubkey(&pubkey).await? }))
        }
        "user.is_vanished" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            Ok(json!({ "value": repos.users.is_vanished(&pubkey).await? }))
        }
        "user.set_vanished" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            let vanished = request["vanished"].as_bool().expect("vanished");
            Ok(json!({ "count": repos.users.set_vanished(&pubkey, vanished).await? }))
        }
        "user.admit_user" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            repos
                .users
                .admit_user(&pubkey, parse_iso(&request["admitted_at"]))
                .await?;
            Ok(json!({ "ok": true }))
        }
        "user.tos_accepted_at" => Err(nostream_storage::StorageError::NotImplemented {
            module: "tests::common::user_tos_accepted_at",
        }),
        "user.revoke_admission" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            Ok(json!({ "count": repos.users.revoke_admission(&pubkey).await? }))
        }
        "invoice.find_by_id" => {
            let id = text(request, "id");
            Ok(json!({ "invoice": optional_invoice_view(&repos.invoices.find_by_id(&id).await?) }))
        }
        "invoice.upsert" => {
            let value = &request["invoice"];
            let invoice = Invoice {
                id: text(value, "id"),
                pubkey: parse_pubkey(&value["pubkey"]),
                bolt11: text(value, "bolt11"),
                amount_requested: integer(value, "amount_requested"),
                amount_paid: value.get("amount_paid").and_then(Value::as_i64),
                unit: value["unit"]
                    .as_str()
                    .expect("a unit")
                    .parse()
                    .expect("a unit"),
                status: value["status"]
                    .as_str()
                    .expect("a status")
                    .parse()
                    .expect("a status"),
                description: text(value, "description"),
                confirmed_at: value
                    .get("confirmed_at")
                    .filter(|value| !value.is_null())
                    .map(parse_iso),
                expires_at: value
                    .get("expires_at")
                    .filter(|value| !value.is_null())
                    .map(parse_iso),
                updated_at: parse_iso(&value["created_at"]),
                created_at: parse_iso(&value["created_at"]),
                verify_url: optional_text(value, "verify_url"),
            };
            Ok(json!({ "count": repos.invoices.upsert(&invoice).await? }))
        }
        "invoice.update_status" => {
            let id = text(request, "id");
            let status: InvoiceStatus = request["status"]
                .as_str()
                .expect("a status")
                .parse()
                .expect("a status");
            Ok(json!({
                "invoice": optional_invoice_view(&repos.invoices.update_status(&id, status).await?)
            }))
        }
        "invoice.confirm_invoice" => {
            let id = text(request, "invoice_id");
            repos
                .invoices
                .confirm_invoice(
                    &id,
                    integer(request, "amount_received"),
                    parse_iso(&request["confirmed_at"]),
                )
                .await?;
            Ok(json!({ "ok": true }))
        }
        "invoice.find_pending_invoices" => {
            let offset = integer(request, "offset") as u64;
            let limit = integer(request, "limit") as u64;
            let invoices = repos.invoices.find_pending_invoices(offset, limit).await?;
            Ok(json!({
                "invoices": invoices.iter().map(invoice_view).collect::<Vec<_>>()
            }))
        }
        "nip05.find_by_pubkey" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            let verification = repos.nip05.find_by_pubkey(&pubkey).await?;
            Ok(json!({
                "verification": verification.as_ref().map(nip05_view).unwrap_or(Value::Null)
            }))
        }
        "nip05.upsert" => {
            let value = &request["verification"];
            let verification = Nip05Verification {
                pubkey: parse_pubkey(&value["pubkey"]),
                nip05: text(value, "nip05"),
                domain: text(value, "domain"),
                is_verified: value["is_verified"].as_bool().expect("is_verified"),
                last_verified_at: value
                    .get("last_verified_at")
                    .filter(|value| !value.is_null())
                    .map(parse_iso),
                last_checked_at: parse_iso(&value["last_checked_at"]),
                failure_count: integer(value, "failure_count") as i32,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            };
            Ok(json!({ "count": repos.nip05.upsert(&verification).await? }))
        }
        "nip05.find_pending_verifications" => {
            let verifications = repos
                .nip05
                .find_pending_verifications(
                    integer(request, "update_frequency_ms"),
                    integer(request, "max_failures") as i32,
                    integer(request, "limit") as u64,
                )
                .await?;
            Ok(json!({
                "verifications": verifications.iter().map(nip05_view).collect::<Vec<_>>()
            }))
        }
        "nip05.delete_by_pubkey" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            Ok(json!({ "count": repos.nip05.delete_by_pubkey(&pubkey).await? }))
        }
        "invite.create" => {
            let options = CreateInviteCodeOptions {
                expires_at: request["options"]
                    .get("expires_at")
                    .filter(|value| !value.is_null())
                    .map(parse_iso),
                remaining_uses: match field_update(
                    request["options"]
                        .get("remaining_uses")
                        .unwrap_or(&json!({"kind": "absent"})),
                ) {
                    FieldUpdate::Absent => FieldUpdate::Absent,
                    FieldUpdate::Clear => FieldUpdate::Clear,
                    FieldUpdate::Set(value) => {
                        FieldUpdate::Set(value.as_i64().expect("remaining uses") as i32)
                    }
                },
                created_by: optional_text(&request["options"], "created_by")
                    .map(|pubkey| pubkey.parse().expect("a pubkey")),
            };
            let code = text(request, "code");
            let invite = repos.invites.create(&code, &options).await?;
            Ok(json!({ "invite": invite_view(&invite) }))
        }
        "invite.find_by_code" => {
            let code = text(request, "code");
            let invite = repos.invites.find_by_code(&code).await?;
            Ok(json!({ "invite": invite.as_ref().map(invite_view).unwrap_or(Value::Null) }))
        }
        "invite.claim_code" => {
            let code = text(request, "code");
            let pubkey = parse_pubkey(&request["pubkey"]);
            Ok(json!({ "value": repos.invites.claim_code(&code, &pubkey).await? }))
        }
        "invite.find_active_codes" => {
            let mut invites = repos
                .invites
                .find_active_codes(integer(request, "limit") as u64)
                .await?;
            sort_by_key(&mut invites, |invite| invite.code.clone());
            Ok(json!({ "invites": invites.iter().map(invite_view).collect::<Vec<_>>() }))
        }
        "invite.delete_expired_codes" => {
            Ok(json!({ "count": repos.invites.delete_expired_codes().await? }))
        }
        "dvm.create" => {
            let id = parse_event_id(&request["id"]);
            let requester = parse_pubkey(&request["requester"]);
            let kind = Kind(request["kind"].as_u64().expect("a kind"));
            let job = repos.dvm.create(&id, &requester, kind).await?;
            Ok(json!({ "job": dvm_view(&job) }))
        }
        "dvm.find_by_id" => {
            let id = parse_event_id(&request["id"]);
            Ok(json!({ "job": optional_dvm_view(&repos.dvm.find_by_id(&id).await?) }))
        }
        "dvm.assign_worker" => {
            let id = parse_event_id(&request["id"]);
            let worker_index = integer(request, "worker_index") as i32;
            Ok(json!({ "value": repos.dvm.assign_worker(&id, worker_index).await? }))
        }
        "dvm.update_status" => {
            let update = &request["update"];
            let dvm_update = DvmJobUpdate {
                id: parse_event_id(&update["id"]),
                status: update["status"]
                    .as_str()
                    .expect("a status")
                    .parse()
                    .expect("a status"),
                result_event_id: match field_update(&update["result_event_id"]) {
                    FieldUpdate::Absent => FieldUpdate::Absent,
                    FieldUpdate::Clear => FieldUpdate::Clear,
                    FieldUpdate::Set(value) => FieldUpdate::Set(parse_event_id(&value)),
                },
                error: match field_update(&update["error"]) {
                    FieldUpdate::Absent => FieldUpdate::Absent,
                    FieldUpdate::Clear => FieldUpdate::Clear,
                    FieldUpdate::Set(value) => {
                        FieldUpdate::Set(value.as_str().expect("an error").to_owned())
                    }
                },
            };
            Ok(json!({ "job": optional_dvm_view(&repos.dvm.update_status(&dvm_update).await?) }))
        }
        "dvm.find_pending_jobs" => {
            let kinds: Option<Vec<Kind>> =
                request.get("kinds").and_then(Value::as_array).map(|kinds| {
                    kinds
                        .iter()
                        .map(|kind| Kind(kind.as_u64().expect("a kind")))
                        .collect()
                });
            let mut jobs = repos
                .dvm
                .find_pending_jobs(integer(request, "limit") as u64, kinds.as_deref())
                .await?;
            sort_by_key(&mut jobs, |job| job.id.to_string());
            Ok(json!({ "jobs": jobs.iter().map(dvm_view).collect::<Vec<_>>() }))
        }
        "report.create" => {
            let report = new_report(&request["report"]);
            let created = repos.reports.create(&report).await?;
            Ok(json!({ "report": report_view(&created) }))
        }
        "report.create_many" => {
            let reports: Vec<NewReport> = request["reports"]
                .as_array()
                .expect("reports")
                .iter()
                .map(new_report)
                .collect();
            let mut created = repos.reports.create_many(&reports).await?;
            sort_by_key(&mut created, |report| report.id.to_string());
            Ok(json!({ "reports": created.iter().map(report_view).collect::<Vec<_>>() }))
        }
        "report.find_by_event_id" => {
            let event_id = parse_event_id(&request["event_id"]);
            let mut reports = repos.reports.find_by_event_id(&event_id).await?;
            sort_by_key(&mut reports, |report| report.id.to_string());
            Ok(json!({ "reports": reports.iter().map(report_view).collect::<Vec<_>>() }))
        }
        "report.find_actionable" => {
            let mut reports = repos
                .reports
                .find_actionable(integer(request, "limit") as u64)
                .await?;
            sort_by_key(&mut reports, |report| report.id.to_string());
            Ok(json!({ "reports": reports.iter().map(report_view).collect::<Vec<_>>() }))
        }
        "report.find_actionable_targets" => {
            let mut targets: Vec<ActionableTarget> =
                repos.reports.find_actionable_targets().await?;
            sort_by_key(&mut targets, |target| {
                format!(
                    "{}/{}",
                    target
                        .reported_pubkey
                        .map(|pubkey| pubkey.to_string())
                        .unwrap_or_else(|| "null".to_owned()),
                    target
                        .reported_event_id
                        .map(|id| id.to_string())
                        .unwrap_or_else(|| "null".to_owned())
                )
            });
            Ok(json!({
                "targets": targets.iter().map(|target| json!({
                    "reported_pubkey": target.reported_pubkey.map(|pubkey| pubkey.to_string()),
                    "reported_event_id": target
                        .reported_event_id
                        .map(|id| id.to_string()),
                })).collect::<Vec<_>>()
            }))
        }
        "delivery_log.append" => {
            let entry = &request["entry"];
            let outbox_id = match entry.get("outbox_id_from") {
                Some(_) => Some(resolve_ref(refs, entry)?),
                None => optional_text(entry, "outbox_id"),
            };
            let new_entry = NewDeliveryLogEntry {
                outbox_id,
                event_type: text(entry, "event_type"),
                target_id: text(entry, "target_id"),
                target_type: entry["target_type"]
                    .as_str()
                    .expect("a target type")
                    .parse()
                    .expect("a target type"),
                status: entry["status"]
                    .as_str()
                    .expect("a status")
                    .parse()
                    .expect("a status"),
                attempt_number: integer(entry, "attempt_number") as i32,
                error_snippet: optional_text(entry, "error_snippet"),
            };
            repos.delivery_log.append(&new_entry).await?;
            Ok(json!({ "ok": true }))
        }
        "delivery_log.find_recent" => {
            let filters = DeliveryLogFilters {
                status: request["filters"]
                    .get("status")
                    .and_then(Value::as_str)
                    .map(|status| status.parse().expect("a status")),
                event_type: request["filters"]
                    .get("event_type")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            };
            let mut entries = repos
                .delivery_log
                .find_recent(integer(request, "limit") as u64, &filters)
                .await?;
            sort_by_key(&mut entries, |entry| {
                format!("{}/{:02}", entry.target_id, entry.attempt_number)
            });
            Ok(json!({ "entries": entries.iter().map(delivery_view).collect::<Vec<_>>() }))
        }
        "delivery_log.find_successful_target_ids" => {
            let outbox_id = match request.get("outbox_id_from") {
                Some(_) => resolve_ref(refs, request)?,
                None => text(request, "outbox_id"),
            };
            let mut ids = repos
                .delivery_log
                .find_successful_target_ids(&outbox_id)
                .await?;
            ids.sort();
            Ok(json!({ "target_ids": ids }))
        }
        "delivery_log.delete_older_than" => {
            let cutoff = parse_iso(&request["cutoff"]);
            Ok(json!({ "count": repos.delivery_log.delete_older_than(cutoff).await? }))
        }
        "outbox.enqueue" => {
            let event_type = text(request, "event_type");
            let message = repos
                .outbox
                .enqueue(&event_type, &request["payload"])
                .await?;
            refs.insert(message.event_type.clone(), message.id.clone());
            Ok(json!({ "message": outbox_view(&message) }))
        }
        "outbox.claim_batch" => {
            let mut messages = repos
                .outbox
                .claim_batch(integer(request, "limit") as u64)
                .await?;
            sort_by_key(&mut messages, |message| message.event_type.clone());
            Ok(json!({ "messages": messages.iter().map(outbox_view).collect::<Vec<_>>() }))
        }
        "outbox.mark_delivered" => {
            let id = resolve_ref(refs, request)?;
            repos.outbox.mark_delivered(&id).await?;
            Ok(json!({ "ok": true }))
        }
        "outbox.mark_failed" => {
            let id = resolve_ref(refs, request)?;
            repos
                .outbox
                .mark_failed(
                    &id,
                    &text(request, "error"),
                    integer(request, "attempt_count") as i32,
                    integer(request, "max_attempts") as i32,
                    integer(request, "base_delay_ms"),
                )
                .await?;
            Ok(json!({ "ok": true }))
        }
        "outbox.delete_terminal_older_than" => {
            let cutoff = parse_iso(&request["cutoff"]);
            Ok(json!({ "count": repos.outbox.delete_terminal_older_than(cutoff).await? }))
        }
        "transaction" => Err(nostream_storage::StorageError::NotImplemented {
            module: "tests::common::transaction",
        }),
        other => panic!("unknown op {other}"),
    }
}
