//! `Nip05VerificationRepository`, `InviteCodeRepository`, `DvmJobRepository` and
//! `ReportRepository` against Postgres. Mirrors the four `src/repositories/*` files.

use chrono::{Duration, Utc};
use nostream_core::{EventId, Kind, Pubkey};
use sqlx::postgres::Postgres;
use sqlx::{Executor, Row};

use super::{Arg, Args, EventQuery};
use crate::error::StorageError;
use crate::repositories::{
    ActionableTarget, CreateInviteCodeOptions, DvmJob, DvmJobStatus, DvmJobUpdate, FieldUpdate,
    InviteCode, NewReport, Nip05Verification, Report,
};

const NIP05_COLUMNS: &str = "pubkey, nip05, domain, is_verified, last_verified_at, \
last_checked_at, failure_count, created_at, updated_at";

const INVITE_COLUMNS: &str =
    "code, created_by, claimed_by, expires_at, remaining_uses, created_at, updated_at";

const DVM_COLUMNS: &str = "id, requester_pubkey, kind, worker_index, status, result_event_id, \
error, picked_up_at, completed_at, created_at, updated_at";

const REPORT_COLUMNS: &str = "id, event_id, reporter_pubkey, reported_pubkey, \
reported_event_id, report_type, weight, actionable, created_at";

/// `Nip05VerificationRepository::find_by_pubkey`.
pub(crate) async fn nip05_find_by_pubkey<'e, E>(
    executor: E,
    pubkey: &Pubkey,
) -> Result<Option<Nip05Verification>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let pubkey_slot = args.push(Arg::Bytes(pubkey.as_bytes().to_vec()));
    let sql =
        format!("SELECT {NIP05_COLUMNS} FROM nip05_verifications WHERE pubkey = {pubkey_slot}");
    let row = EventQuery { sql, args }
        .into_query()
        .fetch_optional(executor)
        .await?;

    row.as_ref()
        .map(super::rows::nip05_verification)
        .transpose()
}

/// `Nip05VerificationRepository::upsert`: every column but `pubkey` and `created_at`.
pub(crate) async fn nip05_upsert<'e, E>(
    executor: E,
    verification: &Nip05Verification,
) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let mut args = Args::default();
    let pubkey_slot = args.push(Arg::Bytes(verification.pubkey.as_bytes().to_vec()));
    let nip05_slot = args.push(Arg::Text(verification.nip05.clone()));
    let domain_slot = args.push(Arg::Text(verification.domain.clone()));
    let verified_slot = args.push(Arg::Bool(verification.is_verified));
    let last_verified_slot = match verification.last_verified_at {
        Some(value) => args.push(Arg::Timestamp(value)),
        None => args.push(Arg::NullTimestamp),
    };
    let last_checked_slot = args.push(Arg::Timestamp(verification.last_checked_at));
    let failures_slot = args.push(Arg::Int(verification.failure_count));
    let created_slot = args.push(Arg::Timestamp(now));
    let updated_slot = args.push(Arg::Timestamp(now));
    let sql = format!(
        "INSERT INTO nip05_verifications ({NIP05_COLUMNS}) VALUES ({pubkey_slot}, {nip05_slot}, \
         {domain_slot}, {verified_slot}, {last_verified_slot}, {last_checked_slot}, \
         {failures_slot}, {created_slot}, {updated_slot}) ON CONFLICT (pubkey) DO UPDATE SET \
         nip05 = excluded.nip05, domain = excluded.domain, is_verified = excluded.is_verified, \
         last_verified_at = excluded.last_verified_at, \
         last_checked_at = excluded.last_checked_at, \
         failure_count = excluded.failure_count, updated_at = excluded.updated_at"
    );

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected())
}

/// `Nip05VerificationRepository::find_pending_verifications`: rows last checked before the
/// cutoff, ordered by that check.
pub(crate) async fn nip05_find_pending<'e, E>(
    executor: E,
    update_frequency_ms: i64,
    max_failures: i32,
    limit: u64,
) -> Result<Vec<Nip05Verification>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let cutoff = Utc::now() - Duration::milliseconds(update_frequency_ms);
    let mut args = Args::default();
    let cutoff_slot = args.push(Arg::Timestamp(cutoff));
    let failures_slot = args.push(Arg::Int(max_failures));
    let limit_slot = args.push(Arg::BigInt(limit as i64));
    let sql = format!(
        "SELECT {NIP05_COLUMNS} FROM nip05_verifications WHERE last_checked_at < {cutoff_slot} \
         AND failure_count < {failures_slot} ORDER BY last_checked_at ASC LIMIT {limit_slot}"
    );
    let rows = EventQuery { sql, args }
        .into_query()
        .fetch_all(executor)
        .await?;

    rows.iter().map(super::rows::nip05_verification).collect()
}

/// `Nip05VerificationRepository::delete_by_pubkey`.
pub(crate) async fn nip05_delete_by_pubkey<'e, E>(
    executor: E,
    pubkey: &Pubkey,
) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let pubkey_slot = args.push(Arg::Bytes(pubkey.as_bytes().to_vec()));
    let sql = format!("DELETE FROM nip05_verifications WHERE pubkey = {pubkey_slot}");

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected())
}

/// `InviteCodeRepository::create`: the capture returns the row it built, so this does too.
pub(crate) async fn invite_create<'e, E>(
    executor: E,
    code: &str,
    options: &CreateInviteCodeOptions,
) -> Result<InviteCode, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let mut args = Args::default();
    let code_slot = args.push(Arg::Text(code.to_owned()));
    let created_by_slot = match &options.created_by {
        Some(pubkey) => args.push(Arg::Bytes(pubkey.as_bytes().to_vec())),
        None => args.push(Arg::NullBytes),
    };
    let claimed_by_slot = args.push(Arg::NullBytes);
    let expires_slot = match options.expires_at {
        Some(expires_at) => args.push(Arg::Timestamp(expires_at)),
        None => args.push(Arg::NullTimestamp),
    };
    let remaining_uses = match options.remaining_uses {
        FieldUpdate::Absent => 1,
        FieldUpdate::Clear => -1,
        FieldUpdate::Set(uses) => uses,
    };
    let remaining_slot = if remaining_uses < 0 {
        args.push(Arg::NullInt)
    } else {
        args.push(Arg::Int(remaining_uses))
    };
    let created_slot = args.push(Arg::Timestamp(now));
    let updated_slot = args.push(Arg::Timestamp(now));
    let sql = format!(
        "INSERT INTO invite_codes ({INVITE_COLUMNS}) VALUES ({code_slot}, {created_by_slot}, \
         {claimed_by_slot}, {expires_slot}, {remaining_slot}, {created_slot}, {updated_slot})"
    );

    EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?;

    Ok(InviteCode {
        code: code.to_owned(),
        created_by: options.created_by,
        claimed_by: None,
        expires_at: options.expires_at,
        remaining_uses: if remaining_uses < 0 {
            None
        } else {
            Some(remaining_uses)
        },
        created_at: now,
        updated_at: now,
    })
}

/// `InviteCodeRepository::find_by_code`.
pub(crate) async fn invite_find_by_code<'e, E>(
    executor: E,
    code: &str,
) -> Result<Option<InviteCode>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let code_slot = args.push(Arg::Text(code.to_owned()));
    let sql = format!("SELECT {INVITE_COLUMNS} FROM invite_codes WHERE code = {code_slot}");
    let row = EventQuery { sql, args }
        .into_query()
        .fetch_optional(executor)
        .await?;

    row.as_ref().map(super::rows::invite_code).transpose()
}

/// `InviteCodeRepository::claim_code`: one conditional update, so exactly one caller wins.
pub(crate) async fn invite_claim_code<'e, E>(
    executor: E,
    code: &str,
    pubkey: &Pubkey,
) -> Result<bool, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let mut args = Args::default();
    let code_slot = args.push(Arg::Text(code.to_owned()));
    let pubkey_slot = args.push(Arg::Bytes(pubkey.as_bytes().to_vec()));
    let now_slot = args.push(Arg::Timestamp(now));
    let sql = format!(
        "UPDATE invite_codes SET remaining_uses = remaining_uses - 1, \
         claimed_by = COALESCE(claimed_by, {pubkey_slot}), updated_at = {now_slot} \
         WHERE code = {code_slot} AND (remaining_uses IS NULL OR remaining_uses > 0) \
         AND (expires_at IS NULL OR expires_at > {now_slot})"
    );

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected()
        > 0)
}

/// `InviteCodeRepository::find_active_codes`: unexpired and claimable, newest first.
pub(crate) async fn invite_find_active_codes<'e, E>(
    executor: E,
    limit: u64,
) -> Result<Vec<InviteCode>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let mut args = Args::default();
    let now_slot = args.push(Arg::Timestamp(now));
    let limit_slot = args.push(Arg::BigInt(limit as i64));
    let sql = format!(
        "SELECT {INVITE_COLUMNS} FROM invite_codes \
         WHERE (expires_at IS NULL OR expires_at > {now_slot}) \
         AND (remaining_uses IS NULL OR remaining_uses > 0) \
         ORDER BY created_at DESC LIMIT {limit_slot}"
    );
    let rows = EventQuery { sql, args }
        .into_query()
        .fetch_all(executor)
        .await?;

    rows.iter().map(super::rows::invite_code).collect()
}

/// `InviteCodeRepository::delete_expired_codes`.
pub(crate) async fn invite_delete_expired<'e, E>(executor: E) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let now_slot = args.push(Arg::Timestamp(Utc::now()));
    let sql = format!(
        "DELETE FROM invite_codes WHERE expires_at IS NOT NULL AND expires_at <= {now_slot}"
    );

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected())
}

/// `DvmJobRepository::create`: a submitted job with every optional column empty.
pub(crate) async fn dvm_create<'e, E>(
    executor: E,
    id: &EventId,
    requester: &Pubkey,
    kind: Kind,
) -> Result<DvmJob, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let mut args = Args::default();
    let id_slot = args.push(Arg::Bytes(id.as_bytes().to_vec()));
    let requester_slot = args.push(Arg::Bytes(requester.as_bytes().to_vec()));
    let kind_slot = args.push(Arg::Int(int32(kind.0 as i64, "kind")?));
    let status_slot = args.push(Arg::Text(DvmJobStatus::Submitted.as_str().to_owned()));
    let created_slot = args.push(Arg::Timestamp(now));
    let updated_slot = args.push(Arg::Timestamp(now));
    let sql = format!(
        "INSERT INTO dvm_jobs (id, requester_pubkey, kind, worker_index, status, \
         result_event_id, error, picked_up_at, completed_at, created_at, updated_at) \
         VALUES ({id_slot}, {requester_slot}, {kind_slot}, NULL, {status_slot}, NULL, NULL, \
         NULL, NULL, {created_slot}, {updated_slot})"
    );

    EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?;

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
}

/// `DvmJobRepository::find_by_id`.
pub(crate) async fn dvm_find_by_id<'e, E>(
    executor: E,
    id: &EventId,
) -> Result<Option<DvmJob>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let id_slot = args.push(Arg::Bytes(id.as_bytes().to_vec()));
    let sql = format!("SELECT {DVM_COLUMNS} FROM dvm_jobs WHERE id = {id_slot}");
    let row = EventQuery { sql, args }
        .into_query()
        .fetch_optional(executor)
        .await?;

    row.as_ref().map(super::rows::dvm_job).transpose()
}

/// `DvmJobRepository::assign_worker`: a conditional update from `submitted`.
pub(crate) async fn dvm_assign_worker<'e, E>(
    executor: E,
    id: &EventId,
    worker_index: i32,
) -> Result<bool, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let mut args = Args::default();
    let id_slot = args.push(Arg::Bytes(id.as_bytes().to_vec()));
    let worker_slot = args.push(Arg::Int(worker_index));
    let picked_slot = args.push(Arg::Timestamp(now));
    let updated_slot = args.push(Arg::Timestamp(now));
    let submitted_slot = args.push(Arg::Text(DvmJobStatus::Submitted.as_str().to_owned()));
    let picked_up_slot = args.push(Arg::Text(DvmJobStatus::PickedUp.as_str().to_owned()));
    let sql = format!(
        "UPDATE dvm_jobs SET worker_index = {worker_slot}, status = {picked_up_slot}, \
         picked_up_at = {picked_slot}, updated_at = {updated_slot} \
         WHERE id = {id_slot} AND status = {submitted_slot}"
    );

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected()
        > 0)
}

/// `DvmJobRepository::update_status`: the `FieldUpdate` fields are applied by key presence.
pub(crate) async fn dvm_update_status<'e, E>(
    executor: E,
    update: &DvmJobUpdate,
) -> Result<Option<DvmJob>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let mut args = Args::default();
    let mut assignments = Vec::new();

    let status_slot = args.push(Arg::Text(update.status.as_str().to_owned()));
    assignments.push(format!("status = {status_slot}"));
    let updated_slot = args.push(Arg::Timestamp(now));
    assignments.push(format!("updated_at = {updated_slot}"));
    if update.status.is_terminal() {
        let completed_slot = args.push(Arg::Timestamp(now));
        assignments.push(format!("completed_at = {completed_slot}"));
    }
    match &update.result_event_id {
        FieldUpdate::Absent => {}
        FieldUpdate::Clear => assignments.push("result_event_id = NULL".to_owned()),
        FieldUpdate::Set(id) => {
            let slot = args.push(Arg::Bytes(id.as_bytes().to_vec()));
            assignments.push(format!("result_event_id = {slot}"));
        }
    }
    match &update.error {
        FieldUpdate::Absent => {}
        FieldUpdate::Clear => assignments.push("error = NULL".to_owned()),
        FieldUpdate::Set(error) => {
            let slot = args.push(Arg::Text(error.clone()));
            assignments.push(format!("error = {slot}"));
        }
    }

    let id_slot = args.push(Arg::Bytes(update.id.as_bytes().to_vec()));
    let sql = format!(
        "UPDATE dvm_jobs SET {} WHERE id = {id_slot} RETURNING {DVM_COLUMNS}",
        assignments.join(", ")
    );
    let row = EventQuery { sql, args }
        .into_query()
        .fetch_optional(executor)
        .await?;

    row.as_ref().map(super::rows::dvm_job).transpose()
}

/// `DvmJobRepository::find_pending_jobs`: submitted and picked-up jobs, oldest first.
pub(crate) async fn dvm_find_pending_jobs<'e, E>(
    executor: E,
    limit: u64,
    kinds: Option<&[Kind]>,
) -> Result<Vec<DvmJob>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let statuses = args.push(Arg::TextList(vec![
        DvmJobStatus::Submitted.as_str().to_owned(),
        DvmJobStatus::PickedUp.as_str().to_owned(),
    ]));
    let mut kinds_clause = String::new();
    if let Some(kinds) = kinds.filter(|kinds| !kinds.is_empty()) {
        let kinds: Vec<i32> = kinds
            .iter()
            .map(|kind| int32(kind.0 as i64, "kind"))
            .collect::<Result<_, _>>()?;
        let kinds_slot = args.push(Arg::IntList(kinds));
        kinds_clause = format!(" AND kind = ANY({kinds_slot})");
    }
    let limit_slot = args.push(Arg::BigInt(limit as i64));
    let sql = format!(
        "SELECT {DVM_COLUMNS} FROM dvm_jobs WHERE status = ANY({statuses}){kinds_clause} \
         ORDER BY created_at ASC LIMIT {limit_slot}"
    );
    let rows = EventQuery { sql, args }
        .into_query()
        .fetch_all(executor)
        .await?;

    rows.iter().map(super::rows::dvm_job).collect()
}

/// `ReportRepository::create`: inserts the row and returns it with its generated id.
pub(crate) async fn report_create<'e, E>(
    executor: E,
    report: &NewReport,
) -> Result<Report, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let mut args = Args::default();
    let event_slot = args.push(Arg::Bytes(report.event_id.as_bytes().to_vec()));
    let reporter_slot = args.push(Arg::Bytes(report.reporter_pubkey.as_bytes().to_vec()));
    let reported_pubkey_slot = match &report.reported_pubkey {
        Some(pubkey) => args.push(Arg::Bytes(pubkey.as_bytes().to_vec())),
        None => args.push(Arg::NullBytes),
    };
    let reported_event_slot = match &report.reported_event_id {
        Some(id) => args.push(Arg::Bytes(id.as_bytes().to_vec())),
        None => args.push(Arg::NullBytes),
    };
    let type_slot = args.push(Arg::Text(report.report_type.as_str().to_owned()));
    let weight_slot = args.push(Arg::Real(report.weight));
    let actionable_slot = args.push(Arg::Bool(report.actionable));
    let created_slot = args.push(Arg::Timestamp(now));
    let sql = format!(
        "INSERT INTO reports (event_id, reporter_pubkey, reported_pubkey, reported_event_id, \
         report_type, weight, actionable, created_at) VALUES ({event_slot}, {reporter_slot}, \
         {reported_pubkey_slot}, {reported_event_slot}, {type_slot}, {weight_slot}, \
         {actionable_slot}, {created_slot}) RETURNING id"
    );
    let row = EventQuery { sql, args }
        .into_query()
        .fetch_one(executor)
        .await?;

    Ok(Report {
        id: row.try_get("id")?,
        event_id: report.event_id,
        reporter_pubkey: report.reporter_pubkey,
        reported_pubkey: report.reported_pubkey,
        reported_event_id: report.reported_event_id,
        report_type: report.report_type,
        weight: report.weight,
        actionable: report.actionable,
        created_at: now,
    })
}

/// `ReportRepository::find_by_event_id`.
pub(crate) async fn report_find_by_event_id<'e, E>(
    executor: E,
    event_id: &EventId,
) -> Result<Vec<Report>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let event_slot = args.push(Arg::Bytes(event_id.as_bytes().to_vec()));
    let sql = format!("SELECT {REPORT_COLUMNS} FROM reports WHERE event_id = {event_slot}");
    let rows = EventQuery { sql, args }
        .into_query()
        .fetch_all(executor)
        .await?;

    rows.iter().map(super::rows::report).collect()
}

/// `ReportRepository::find_actionable`: actionable rows, newest first.
pub(crate) async fn report_find_actionable<'e, E>(
    executor: E,
    limit: u64,
) -> Result<Vec<Report>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let limit_slot = args.push(Arg::BigInt(limit as i64));
    let sql = format!(
        "SELECT {REPORT_COLUMNS} FROM reports WHERE actionable = true \
         ORDER BY created_at DESC LIMIT {limit_slot}"
    );
    let rows = EventQuery { sql, args }
        .into_query()
        .fetch_all(executor)
        .await?;

    rows.iter().map(super::rows::report).collect()
}

/// `ReportRepository::find_actionable_targets`: every distinct target, unpaginated.
pub(crate) async fn report_find_actionable_targets<'e, E>(
    executor: E,
) -> Result<Vec<ActionableTarget>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let sql = "SELECT DISTINCT reported_pubkey, reported_event_id FROM reports \
               WHERE actionable = true";
    let rows = EventQuery {
        sql: sql.to_owned(),
        args: Args::default(),
    }
    .into_query()
    .fetch_all(executor)
    .await?;

    rows.iter()
        .map(|row| {
            let reported_pubkey = optional_bytes(row, "reported_pubkey")?
                .map(|bytes| bytes_to_pubkey(bytes, "reported_pubkey"))
                .transpose()?;
            let reported_event_id = optional_bytes(row, "reported_event_id")?
                .map(|bytes| bytes_to_event_id(bytes, "reported_event_id"))
                .transpose()?;
            Ok(ActionableTarget {
                reported_pubkey,
                reported_event_id,
            })
        })
        .collect()
}

fn int32(value: i64, column: &'static str) -> Result<i32, StorageError> {
    i32::try_from(value).map_err(|_| StorageError::ValueOutOfRange {
        column,
        value: value.to_string(),
    })
}

fn optional_bytes(
    row: &sqlx::postgres::PgRow,
    column: &'static str,
) -> Result<Option<Vec<u8>>, StorageError> {
    Ok(row.try_get::<Option<Vec<u8>>, _>(column)?)
}

fn bytes_to_pubkey(bytes: Vec<u8>, column: &'static str) -> Result<Pubkey, StorageError> {
    bytes
        .try_into()
        .map(Pubkey::from_byte_array)
        .map_err(|bytes: Vec<u8>| StorageError::ValueOutOfRange {
            column,
            value: format!("{} bytes", bytes.len()),
        })
}

fn bytes_to_event_id(bytes: Vec<u8>, column: &'static str) -> Result<EventId, StorageError> {
    bytes
        .try_into()
        .map(EventId::from_byte_array)
        .map_err(|bytes: Vec<u8>| StorageError::ValueOutOfRange {
            column,
            value: format!("{} bytes", bytes.len()),
        })
}
