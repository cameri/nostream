//! Behavioural parity: replays `tests/fixtures/repository-parity.json` through
//! `PostgresBackend` and compares every result with the TypeScript implementation's recording.
//!
//! Run with `--ignored` and `PARITY_ADMIN_URL` set; `scripts/storage-parity.sh` does both.
//! The test creates the database if absent and runs the migrator, so this target and
//! `migrations.rs` have no ordering dependency.

#![cfg(feature = "postgres")]
// This integration-test target may unwrap: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::future::poll_fn;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::Executor;
use sqlx::postgres::PgPool;

use nostream_core::{Filter, Kind};
use nostream_storage::postgres::{PostgresBackend, PostgresTransaction};
mod common;

use nostream_storage::repositories::{
    ActionableTarget, CreateInviteCodeOptions, DeliveryLogEntry, DeliveryLogFilters, DvmJob,
    DvmJobRepository, DvmJobUpdate, EventPurgeCounts, EventRecord, EventRepository,
    EventRetentionOptions, FieldUpdate, InviteCode, InviteCodeRepository, Invoice,
    InvoiceRepository, InvoiceStatus, NewDeliveryLogEntry, NewReport, Nip05Verification,
    Nip05VerificationRepository, NotificationDeliveryLogRepository, NotificationOutboxRepository,
    OutboxMessage, QueryStream, ReconciliationItem, Report, ReportRepository, User, UserPatch,
    UserRepository,
};

const DATABASE: &str = "nostream_parity_rust";

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/repository-parity.json"))
        .expect("tests/fixtures/repository-parity.json is valid JSON")
}

fn admin_url() -> String {
    std::env::var("PARITY_ADMIN_URL").expect(
        "PARITY_ADMIN_URL must name an administrative database, e.g. \
         postgres://postgres:postgres@host:5432/postgres",
    )
}

fn with_database(url: &str, database: &str) -> String {
    let (prefix, query) = match url.split_once('?') {
        Some((prefix, query)) => (prefix, Some(query)),
        None => (url, None),
    };
    let base = match prefix.rfind('/') {
        Some(index) if index > "postgres://".len() => &prefix[..index],
        _ => prefix,
    };
    match query {
        Some(query) => format!("{base}/{database}?{query}"),
        None => format!("{base}/{database}"),
    }
}

fn iso(value: &DateTime<Utc>) -> Value {
    Value::String(value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn optional_iso(value: &Option<DateTime<Utc>>) -> Value {
    match value {
        Some(value) => iso(value),
        None => Value::Null,
    }
}

fn parse_iso(value: &Value) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value.as_str().expect("an ISO timestamp"))
        .expect("a valid ISO timestamp")
        .with_timezone(&Utc)
}

fn text(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is a string"))
        .to_owned()
}

fn integer(value: &Value, key: &str) -> i64 {
    value[key]
        .as_i64()
        .unwrap_or_else(|| panic!("{key} is an integer"))
}

fn optional_text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

// ---------------------------------------------------------------------------------------
// Encoders mirroring the generator.
// ---------------------------------------------------------------------------------------

fn event_row(record: &EventRecord) -> Value {
    json!([
        record.event.id.to_string(),
        record.event.created_at,
        record.expires_at,
        record.deleted_at.is_some(),
        record.event_deduplication,
    ])
}

fn event_record(value: &Value) -> EventRecord {
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

fn invoice_view(invoice: &Invoice) -> Value {
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

fn optional_invoice_view(invoice: &Option<Invoice>) -> Value {
    match invoice {
        Some(invoice) => invoice_view(invoice),
        None => Value::Null,
    }
}

fn user_view(user: &User) -> Value {
    json!({
        "pubkey": user.pubkey.to_string(),
        "is_admitted": user.is_admitted,
        "is_vanished": user.is_vanished,
        "balance": user.balance,
    })
}

fn optional_user_view(user: &Option<User>) -> Value {
    match user {
        Some(user) => user_view(user),
        None => Value::Null,
    }
}

fn nip05_view(verification: &Nip05Verification) -> Value {
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

fn invite_view(invite: &InviteCode) -> Value {
    json!({
        "code": invite.code,
        "created_by": invite.created_by.map(|pubkey| pubkey.to_string()),
        "claimed_by": invite.claimed_by.map(|pubkey| pubkey.to_string()),
        "expires_at": optional_iso(&invite.expires_at),
        "remaining_uses": invite.remaining_uses,
    })
}

fn dvm_view(job: &DvmJob) -> Value {
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

fn optional_dvm_view(job: &Option<DvmJob>) -> Value {
    match job {
        Some(job) => dvm_view(job),
        None => Value::Null,
    }
}

fn report_view(report: &Report) -> Value {
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

fn delivery_view(entry: &DeliveryLogEntry) -> Value {
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

fn outbox_view(message: &OutboxMessage) -> Value {
    json!({
        "event_type": message.event_type,
        "payload": message.payload,
        "status": message.status.as_str(),
        "attempt_count": message.attempt_count,
        "last_error": message.last_error,
    })
}

fn sort_by_key<T>(items: &mut [T], key: impl Fn(&T) -> String) {
    items.sort_by_key(|item| key(item));
}

async fn collect<T>(
    mut stream: QueryStream<'_, T>,
) -> Result<Vec<T>, nostream_storage::StorageError> {
    let mut items = Vec::new();
    while let Some(item) = poll_fn(|context| stream.as_mut().poll_next(context)).await {
        items.push(item?);
    }
    Ok(items)
}

/// The three repositories a serializable transaction carries; every other op uses the
/// backend's pools.
#[derive(Clone, Copy)]
enum Client<'a> {
    Backend(&'a PostgresBackend),
    Transaction(&'a PostgresTransaction),
}

impl<'a> Client<'a> {
    fn users(&self) -> &'a dyn UserRepository {
        match self {
            Self::Backend(backend) => *backend,
            Self::Transaction(transaction) => *transaction,
        }
    }

    fn invoices(&self) -> &'a dyn InvoiceRepository {
        match self {
            Self::Backend(backend) => *backend,
            Self::Transaction(transaction) => *transaction,
        }
    }

    fn outbox(&self) -> &'a dyn NotificationOutboxRepository {
        match self {
            Self::Backend(backend) => *backend,
            Self::Transaction(transaction) => *transaction,
        }
    }
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

async fn run_op(
    backend: &PostgresBackend,
    client: Client<'_>,
    op: &Value,
    refs: &mut HashMap<String, String>,
) -> Result<Value, nostream_storage::StorageError> {
    let name = op["op"].as_str().expect("an op name");
    let request = &op["request"];

    match name {
        "events.create" => {
            let record = event_record(&request["record"]);
            Ok(json!({ "count": EventRepository::create(backend, &record).await? }))
        }
        "events.create_many" => {
            let records: Vec<EventRecord> = request["records"]
                .as_array()
                .expect("records")
                .iter()
                .map(event_record)
                .collect();
            Ok(json!({ "count": EventRepository::create_many(backend, &records).await? }))
        }
        "events.upsert" => {
            let record = event_record(&request["record"]);
            Ok(json!({ "count": EventRepository::upsert(backend, &record).await? }))
        }
        "events.upsert_many" => {
            let records: Vec<EventRecord> = request["records"]
                .as_array()
                .expect("records")
                .iter()
                .map(event_record)
                .collect();
            Ok(json!({ "count": EventRepository::upsert_many(backend, &records).await? }))
        }
        "events.find_by_filters" => {
            let filters: Vec<Filter> = request["filters"]
                .as_array()
                .expect("filters")
                .iter()
                .map(|filter| serde_json::from_value(filter.clone()).expect("a filter"))
                .collect();
            if filters.is_empty() {
                let failed = EventRepository::find_by_filters(backend, &[])
                    .await
                    .is_err();
                return Ok(json!({ "error": failed }));
            }
            let rows = collect(EventRepository::find_by_filters(backend, &filters).await?).await?;
            Ok(json!({ "rows": rows.iter().map(event_row).collect::<Vec<_>>() }))
        }
        "events.count_by_filters" => {
            let filters: Vec<Filter> = request["filters"]
                .as_array()
                .expect("filters")
                .iter()
                .map(|filter| serde_json::from_value(filter.clone()).expect("a filter"))
                .collect();
            Ok(json!({ "count": EventRepository::count_by_filters(backend, &filters).await? }))
        }
        "events.find_reconciliation_items" => {
            let filter: Filter =
                serde_json::from_value(request["filter"].clone()).expect("a filter");
            let items =
                collect(EventRepository::find_reconciliation_items(backend, &filter).await?)
                    .await?;
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
            Ok(
                json!({ "count": EventRepository::delete_by_pubkey_and_ids(backend, &pubkey, &ids).await? }),
            )
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
                json!({ "count": EventRepository::delete_by_pubkey_except_kinds(backend, &pubkey, &kinds).await? }),
            )
        }
        "events.has_active_request_to_vanish" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            Ok(
                json!({ "value": EventRepository::has_active_request_to_vanish(backend, &pubkey).await? }),
            )
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
            } = EventRepository::delete_expired_and_retained(backend, &options).await?;
            Ok(json!({ "deleted": deleted, "expired": expired, "retained": retained }))
        }
        "user.find_by_pubkey" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            Ok(
                json!({ "user": optional_user_view(&client.users().find_by_pubkey(&pubkey).await?) }),
            )
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
                is_admitted: patch["is_admitted"].as_bool().expect("is_admitted"),
                is_vanished: patch["is_vanished"].as_bool().expect("is_vanished"),
                tos_accepted_at,
            };
            Ok(json!({ "count": client.users().upsert(&user).await? }))
        }
        "user.get_balance_by_pubkey" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            Ok(json!({ "balance": client.users().get_balance_by_pubkey(&pubkey).await? }))
        }
        "user.is_vanished" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            Ok(json!({ "value": client.users().is_vanished(&pubkey).await? }))
        }
        "user.set_vanished" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            let vanished = request["vanished"].as_bool().expect("vanished");
            Ok(json!({ "count": client.users().set_vanished(&pubkey, vanished).await? }))
        }
        "user.admit_user" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            client
                .users()
                .admit_user(&pubkey, parse_iso(&request["admitted_at"]))
                .await?;
            Ok(json!({ "ok": true }))
        }
        "user.tos_accepted_at" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            let row = sqlx::query("SELECT tos_accepted_at FROM users WHERE pubkey = $1")
                .bind(pubkey.as_bytes().to_vec())
                .fetch_optional(backend.master())
                .await?;
            let value = match row {
                None => Value::Null,
                Some(row) => {
                    let value: Option<chrono::NaiveDateTime> =
                        sqlx::Row::try_get(&row, "tos_accepted_at")?;
                    value
                        .map(|value| iso(&value.and_utc()))
                        .unwrap_or(Value::Null)
                }
            };
            Ok(json!({ "value": value }))
        }
        "user.revoke_admission" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            Ok(json!({ "count": client.users().revoke_admission(&pubkey).await? }))
        }
        "invoice.find_by_id" => {
            let id = text(request, "id");
            Ok(
                json!({ "invoice": optional_invoice_view(&client.invoices().find_by_id(&id).await?) }),
            )
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
            Ok(json!({ "count": client.invoices().upsert(&invoice).await? }))
        }
        "invoice.update_status" => {
            let id = text(request, "id");
            let status: InvoiceStatus = request["status"]
                .as_str()
                .expect("a status")
                .parse()
                .expect("a status");
            Ok(json!({
                "invoice": optional_invoice_view(
                    &client.invoices().update_status(&id, status).await?
                )
            }))
        }
        "invoice.confirm_invoice" => {
            let id = text(request, "invoice_id");
            client
                .invoices()
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
            let invoices = client
                .invoices()
                .find_pending_invoices(offset, limit)
                .await?;
            Ok(json!({
                "invoices": invoices.iter().map(invoice_view).collect::<Vec<_>>()
            }))
        }
        "nip05.find_by_pubkey" => {
            let pubkey = parse_pubkey(&request["pubkey"]);
            let verification =
                Nip05VerificationRepository::find_by_pubkey(backend, &pubkey).await?;
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
            Ok(
                json!({ "count": Nip05VerificationRepository::upsert(backend, &verification).await? }),
            )
        }
        "nip05.find_pending_verifications" => {
            let verifications = backend
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
            Ok(
                json!({ "count": Nip05VerificationRepository::delete_by_pubkey(backend, &pubkey).await? }),
            )
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
            let invite = InviteCodeRepository::create(backend, &code, &options).await?;
            Ok(json!({ "invite": invite_view(&invite) }))
        }
        "invite.find_by_code" => {
            let code = text(request, "code");
            let invite = InviteCodeRepository::find_by_code(backend, &code).await?;
            Ok(json!({ "invite": invite.as_ref().map(invite_view).unwrap_or(Value::Null) }))
        }
        "invite.claim_code" => {
            let code = text(request, "code");
            let pubkey = parse_pubkey(&request["pubkey"]);
            Ok(json!({ "value": InviteCodeRepository::claim_code(backend, &code, &pubkey).await? }))
        }
        "invite.find_active_codes" => {
            let mut invites =
                InviteCodeRepository::find_active_codes(backend, integer(request, "limit") as u64)
                    .await?;
            sort_by_key(&mut invites, |invite| invite.code.clone());
            Ok(json!({ "invites": invites.iter().map(invite_view).collect::<Vec<_>>() }))
        }
        "invite.delete_expired_codes" => {
            Ok(json!({ "count": InviteCodeRepository::delete_expired_codes(backend).await? }))
        }
        "dvm.create" => {
            let id = parse_event_id(&request["id"]);
            let requester = parse_pubkey(&request["requester"]);
            let kind = Kind(request["kind"].as_u64().expect("a kind"));
            let job = DvmJobRepository::create(backend, &id, &requester, kind).await?;
            Ok(json!({ "job": dvm_view(&job) }))
        }
        "dvm.find_by_id" => {
            let id = parse_event_id(&request["id"]);
            Ok(
                json!({ "job": optional_dvm_view(&DvmJobRepository::find_by_id(backend, &id).await?) }),
            )
        }
        "dvm.assign_worker" => {
            let id = parse_event_id(&request["id"]);
            let worker_index = integer(request, "worker_index") as i32;
            Ok(
                json!({ "value": DvmJobRepository::assign_worker(backend, &id, worker_index).await? }),
            )
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
            Ok(
                json!({ "job": optional_dvm_view(&DvmJobRepository::update_status(backend, &dvm_update).await?) }),
            )
        }
        "dvm.find_pending_jobs" => {
            let kinds: Option<Vec<Kind>> =
                request.get("kinds").and_then(Value::as_array).map(|kinds| {
                    kinds
                        .iter()
                        .map(|kind| Kind(kind.as_u64().expect("a kind")))
                        .collect()
                });
            let mut jobs = DvmJobRepository::find_pending_jobs(
                backend,
                integer(request, "limit") as u64,
                kinds.as_deref(),
            )
            .await?;
            sort_by_key(&mut jobs, |job| job.id.to_string());
            Ok(json!({ "jobs": jobs.iter().map(dvm_view).collect::<Vec<_>>() }))
        }
        "report.create" => {
            let report = new_report(&request["report"]);
            let created = ReportRepository::create(backend, &report).await?;
            Ok(json!({ "report": report_view(&created) }))
        }
        "report.create_many" => {
            let reports: Vec<NewReport> = request["reports"]
                .as_array()
                .expect("reports")
                .iter()
                .map(new_report)
                .collect();
            let mut created = ReportRepository::create_many(backend, &reports).await?;
            sort_by_key(&mut created, |report| report.id.to_string());
            Ok(json!({ "reports": created.iter().map(report_view).collect::<Vec<_>>() }))
        }
        "report.find_by_event_id" => {
            let event_id = parse_event_id(&request["event_id"]);
            let mut reports = ReportRepository::find_by_event_id(backend, &event_id).await?;
            sort_by_key(&mut reports, |report| report.id.to_string());
            Ok(json!({ "reports": reports.iter().map(report_view).collect::<Vec<_>>() }))
        }
        "report.find_actionable" => {
            let mut reports =
                ReportRepository::find_actionable(backend, integer(request, "limit") as u64)
                    .await?;
            sort_by_key(&mut reports, |report| report.id.to_string());
            Ok(json!({ "reports": reports.iter().map(report_view).collect::<Vec<_>>() }))
        }
        "report.find_actionable_targets" => {
            let mut targets: Vec<ActionableTarget> =
                ReportRepository::find_actionable_targets(backend).await?;
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
            NotificationDeliveryLogRepository::append(backend, &new_entry).await?;
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
            let mut entries = NotificationDeliveryLogRepository::find_recent(
                backend,
                integer(request, "limit") as u64,
                &filters,
            )
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
            let mut ids =
                NotificationDeliveryLogRepository::find_successful_target_ids(backend, &outbox_id)
                    .await?;
            ids.sort();
            Ok(json!({ "target_ids": ids }))
        }
        "delivery_log.delete_older_than" => {
            let cutoff = parse_iso(&request["cutoff"]);
            Ok(
                json!({ "count": NotificationDeliveryLogRepository::delete_older_than(backend, cutoff).await? }),
            )
        }
        "outbox.enqueue" => {
            let event_type = text(request, "event_type");
            let message = client
                .outbox()
                .enqueue(&event_type, &request["payload"])
                .await?;
            refs.insert(message.event_type.clone(), message.id.clone());
            Ok(json!({ "message": outbox_view(&message) }))
        }
        "outbox.claim_batch" => {
            let mut messages = client
                .outbox()
                .claim_batch(integer(request, "limit") as u64)
                .await?;
            sort_by_key(&mut messages, |message| message.event_type.clone());
            Ok(json!({ "messages": messages.iter().map(outbox_view).collect::<Vec<_>>() }))
        }
        "outbox.mark_delivered" => {
            let id = resolve_ref(refs, request)?;
            client.outbox().mark_delivered(&id).await?;
            Ok(json!({ "ok": true }))
        }
        "outbox.mark_failed" => {
            let id = resolve_ref(refs, request)?;
            client
                .outbox()
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
            Ok(json!({ "count": client.outbox().delete_terminal_older_than(cutoff).await? }))
        }
        other => panic!("unknown op {other}"),
    }
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

fn text_of(value: &Value) -> String {
    value.as_str().expect("a string").to_owned()
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

async fn run_transaction(
    backend: &PostgresBackend,
    op: &Value,
    refs: &mut HashMap<String, String>,
) -> Value {
    let ops = op["request"]["ops"].as_array().expect("transaction ops");
    let transaction = backend.begin().await.expect("a serializable transaction");
    let mut results = Vec::new();
    let mut failed_at = None;

    // One map for the whole group: an enqueue's id has to be addressable by the
    // next op in the same transaction, exactly as the top-level script does.
    // A fresh map per nested op loses it, and `mark_delivered` then has no row
    // to address.
    for (index, nested) in ops.iter().enumerate() {
        match run_op(backend, Client::Transaction(&transaction), nested, refs).await {
            Ok(result) => results.push(result),
            Err(_) => {
                failed_at = Some(index);
                break;
            }
        }
    }

    match failed_at {
        None => {
            transaction.commit().await.expect("the transaction commits");
            json!({ "failed": false, "results": results })
        }
        Some(index) => {
            drop(transaction);
            json!({ "failed": true, "at": index })
        }
    }
}

/// The TLS feature is compiled in (#911). A server that does not offer TLS has
/// to refuse the upgrade; this build must not refuse it first. With `tls-none`
/// sqlx fails before any handshake with "built without TLS support", which is
/// the regression the feature change closes. A server that does offer TLS is the
/// stronger case: the connection succeeds and `SELECT 1` answers.
#[tokio::test]
#[ignore = "needs PARITY_ADMIN_URL; scripts/storage-parity.sh sets it"]
async fn a_tls_connection_is_attempted_rather_than_refused_by_this_build() {
    let admin = admin_url();
    let base = admin.split('?').next().unwrap_or(admin.as_str());
    let url = format!("{base}?sslmode=require");
    match PgPool::connect(&url).await {
        Ok(pool) => {
            let one: i32 = sqlx::query_scalar("SELECT 1")
                .fetch_one(&pool)
                .await
                .expect("SELECT 1 over TLS");
            assert_eq!(one, 1);
            pool.close().await;
        }
        Err(error) => {
            let message = error.to_string();
            assert!(
                !message.contains("built without TLS support"),
                "sqlx refused to negotiate TLS locally: {message}"
            );
        }
    }
}

/// Run the capture's script against a fresh database created through `admin_url`, and return
/// each op's result in order. The one helper both the plaintext and the TLS leg call, so the
/// two runs differ only in how the connection is made.
async fn replay(admin_url: &str, database: &str) -> Vec<Value> {
    let fixture = fixture();
    let admin = PgPool::connect(admin_url)
        .await
        .expect("the administrative database is reachable");
    admin
        .execute(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS {database} WITH (FORCE)"
        )))
        .await
        .expect("the parity database drops");
    admin
        .execute(sqlx::AssertSqlSafe(format!("CREATE DATABASE {database}")))
        .await
        .expect("the parity database is created");
    drop(admin);

    let backend = PostgresBackend::connect(&with_database(admin_url, database))
        .await
        .expect("the parity database is reachable")
        .with_settings(Arc::new(common::settings_from_fixture(&fixture)));
    backend.migrate().await.expect("the schema migrates");

    let corpus: Vec<EventRecord> = fixture["corpus"]
        .as_array()
        .expect("corpus")
        .iter()
        .map(event_record)
        .collect();
    EventRepository::create_many(&backend, &corpus)
        .await
        .expect("the corpus inserts");

    let mut refs = HashMap::new();
    let mut results = Vec::new();
    for (index, op) in fixture["script"]
        .as_array()
        .expect("script")
        .iter()
        .enumerate()
    {
        let name = op["op"].as_str().expect("an op name");
        let actual = if name == "transaction" {
            run_transaction(&backend, op, &mut refs).await
        } else {
            run_op(&backend, Client::Backend(&backend), op, &mut refs)
                .await
                .unwrap_or_else(|error| panic!("op {index} ({name}) failed: {error}"))
        };
        results.push(actual);
    }
    results
}

/// Compare each op's result with the TypeScript capture's.
fn assert_matches_capture(actual: &[Value]) {
    let fixture = fixture();
    let script = fixture["script"].as_array().expect("script");
    assert_eq!(actual.len(), script.len(), "the replay ran every op");
    for (index, (op, got)) in script.iter().zip(actual).enumerate() {
        let name = op["op"].as_str().expect("an op name");
        assert_eq!(
            got, &op["result"]["compare"],
            "op {index} ({name}) differs from the TypeScript capture"
        );
    }
}

#[tokio::test]
#[ignore = "needs PARITY_ADMIN_URL; scripts/storage-parity.sh sets it"]
async fn the_typescript_script_replays_with_an_empty_diff() {
    let actual = replay(&admin_url(), DATABASE).await;
    assert_matches_capture(&actual);
}

/// The same script over TLS and over plaintext, compared op by op (#911).
///
/// `sslmode=require` cannot fall back: a build without the TLS feature fails to connect
/// here rather than downgrading, which is the regression the leg exists to catch. The
/// connection-string option is not taken on trust either: `pg_stat_ssl` reports what the
/// server sees for this session, so a silently plaintext connection fails the leg too.
#[tokio::test]
#[ignore = "needs PARITY_TLS_ADMIN_URL; scripts/storage-parity.sh sets it"]
async fn the_same_replay_over_tls_matches_the_capture_and_the_plaintext_run() {
    let Ok(tls_admin_url) = std::env::var("PARITY_TLS_ADMIN_URL") else {
        eprintln!("PARITY_TLS_ADMIN_URL is unset: the TLS leg runs from scripts/storage-parity.sh");
        return;
    };

    let admin = PgPool::connect(&tls_admin_url)
        .await
        .expect("the TLS administrative database is reachable (is ssl=on?)");
    let encrypted: bool =
        sqlx::query_scalar("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
            .fetch_one(&admin)
            .await
            .expect("pg_stat_ssl answers");
    assert!(
        encrypted,
        "the server reports a plaintext session for a sslmode=require URL"
    );
    drop(admin);

    let over_tls = replay(&tls_admin_url, "nostream_parity_tls").await;
    assert_matches_capture(&over_tls);

    let over_plain = replay(&admin_url(), "nostream_parity_plain").await;
    if over_plain != over_tls {
        let index = over_plain
            .iter()
            .zip(&over_tls)
            .position(|(plain, tls)| plain != tls)
            .unwrap_or(0);
        let fixture = fixture();
        let name = fixture["script"]
            .get(index)
            .and_then(|op| op["op"].as_str())
            .unwrap_or("?");
        panic!(
            "op {index} ({name}) differs between plaintext and TLS: plaintext {:?}, TLS {:?}",
            over_plain.get(index),
            over_tls.get(index)
        );
    }
}
