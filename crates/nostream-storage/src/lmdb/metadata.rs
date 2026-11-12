//! `Nip05VerificationRepository`, `InviteCodeRepository`, `DvmJobRepository` and
//! `ReportRepository` against LMDB. Mirrors the four `src/repositories/*` files.

use std::collections::BTreeSet;

use chrono::{DateTime, Duration, Utc};
use heed::{RoTxn, RwTxn};
use nostream_core::{EventId, Kind, Pubkey};

use super::Databases;
use super::encoding;
use super::encoding::{stamp_key, text_from, text_part};
use super::rows;
use crate::error::StorageError;
use crate::repositories::{
    ActionableTarget, CreateInviteCodeOptions, DvmJob, DvmJobStatus, DvmJobUpdate, FieldUpdate,
    InviteCode, NewReport, Nip05Verification, Report,
};

/// The `meta` key holding the `reports.id` sequence (`reports_id_seq`).
const REPORT_SEQUENCE: &[u8] = b"reports.next_id";

/// The width of `reports.id` in every `reports_*` index key, pinned so a widening is a compile
/// error here rather than a prefix lookup that silently seeks a narrower range.
const REPORT_ID_LEN: usize = 4;

// ---------------------------------------------------------------------------------------
// NIP-05 verifications.
// ---------------------------------------------------------------------------------------

fn nip05_key(pubkey: &Pubkey) -> Vec<u8> {
    pubkey.as_bytes().to_vec()
}

/// `last_checked_at ‖ pubkey`, the key of the pending-check index.
fn nip05_pending_key(verification: &Nip05Verification) -> Vec<u8> {
    let mut key = stamp_key(verification.last_checked_at).to_vec();
    key.extend_from_slice(verification.pubkey.as_bytes());
    key
}

pub(crate) fn nip05_find_by_pubkey(
    txn: &RoTxn<'_>,
    databases: &Databases,
    pubkey: &Pubkey,
) -> Result<Option<Nip05Verification>, StorageError> {
    let Some(value) = databases.nip05.get(txn, &nip05_key(pubkey))? else {
        return Ok(None);
    };
    rows::decode("nip05_verifications", value).map(Some)
}

/// `Nip05VerificationRepository::upsert`: every column but `pubkey` and `created_at` moves.
pub(crate) fn nip05_upsert(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    verification: &Nip05Verification,
    now: DateTime<Utc>,
) -> Result<u64, StorageError> {
    let previous = nip05_find_by_pubkey(txn, databases, &verification.pubkey)?;
    let mut stored = verification.clone();
    stored.created_at = previous
        .as_ref()
        .map_or_else(|| encoding::micros(now), |row| row.created_at);
    // Every timestamp column is a PostgreSQL `timestamp` (V38): the caller's instants are
    // truncated too, not only the ones this backend stamps.
    stored.last_checked_at = encoding::micros(stored.last_checked_at);
    stored.last_verified_at = stored.last_verified_at.map(encoding::micros);
    stored.updated_at = encoding::micros(now);

    let value = rows::encode("nip05_verifications", &stored)?;
    databases
        .nip05
        .put(txn, &nip05_key(&stored.pubkey), &value)?;
    if let Some(previous) = &previous {
        databases
            .nip05_by_last_checked_at
            .delete(txn, &nip05_pending_key(previous))?;
    }
    databases
        .nip05_by_last_checked_at
        .put(txn, &nip05_pending_key(&stored), &[])?;
    Ok(1)
}

/// Writes one verification row and its pending-check entry as the source carries them.
///
/// [`nip05_upsert`] keeps a stored `created_at` and stamps `updated_at`; a migrated row arrives
/// with both of its own, so this puts the row it is given and its own index entry.
pub(super) fn nip05_write(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    verification: &Nip05Verification,
) -> Result<(), StorageError> {
    let value = rows::encode("nip05_verifications", verification)?;
    databases
        .nip05
        .put(txn, &nip05_key(&verification.pubkey), &value)?;
    databases
        .nip05_by_last_checked_at
        .put(txn, &nip05_pending_key(verification), &[])?;
    Ok(())
}

/// `Nip05VerificationRepository::find_pending_verifications`: rows last checked before the
/// cutoff with fewer than `max_failures`, oldest check first.
pub(crate) fn nip05_find_pending(
    txn: &RoTxn<'_>,
    databases: &Databases,
    update_frequency_ms: i64,
    max_failures: i32,
    limit: u64,
    now: DateTime<Utc>,
) -> Result<Vec<Nip05Verification>, StorageError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let cutoff = encoding::micros(now - Duration::milliseconds(update_frequency_ms));
    let mut verifications = Vec::new();
    for entry in databases.nip05_by_last_checked_at.iter(txn)? {
        let (key, _) = entry?;
        let last_checked_at = encoding::i64_from_key(&key[..8])?;
        if last_checked_at >= cutoff.timestamp_micros() {
            break;
        }
        let pubkey = encoding::pubkey_from(&key[8..])?;
        let Some(verification) = nip05_find_by_pubkey(txn, databases, &pubkey)? else {
            continue;
        };
        if verification.failure_count >= max_failures {
            continue;
        }
        verifications.push(verification);
        if verifications.len() as u64 >= limit {
            break;
        }
    }
    Ok(verifications)
}

/// `Nip05VerificationRepository::delete_by_pubkey`.
pub(crate) fn nip05_delete_by_pubkey(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    pubkey: &Pubkey,
) -> Result<u64, StorageError> {
    let Some(verification) = nip05_find_by_pubkey(txn, databases, pubkey)? else {
        return Ok(0);
    };
    databases.nip05.delete(txn, &nip05_key(pubkey))?;
    databases
        .nip05_by_last_checked_at
        .delete(txn, &nip05_pending_key(&verification))?;
    Ok(1)
}

// ---------------------------------------------------------------------------------------
// Invite codes.
// ---------------------------------------------------------------------------------------

fn invite_created_key(invite: &InviteCode) -> Vec<u8> {
    let mut key = stamp_key(invite.created_at).to_vec();
    key.extend_from_slice(invite.code.as_bytes());
    key
}

fn invite_expires_key(invite: &InviteCode, expires_at: DateTime<Utc>) -> Vec<u8> {
    let mut key = stamp_key(expires_at).to_vec();
    key.extend_from_slice(invite.code.as_bytes());
    key
}

pub(crate) fn invite_find_by_code(
    txn: &RoTxn<'_>,
    databases: &Databases,
    code: &str,
) -> Result<Option<InviteCode>, StorageError> {
    let Some(value) = databases.invite_codes.get(txn, code.as_bytes())? else {
        return Ok(None);
    };
    rows::decode("invite_codes", value).map(Some)
}

pub(super) fn invite_write(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    invite: &InviteCode,
) -> Result<(), StorageError> {
    let value = rows::encode("invite_codes", invite)?;
    databases
        .invite_codes
        .put(txn, invite.code.as_bytes(), &value)?;
    databases
        .invite_codes_by_created_at
        .put(txn, &invite_created_key(invite), &[])?;
    if let Some(expires_at) = invite.expires_at {
        databases.invite_codes_by_expires_at.put(
            txn,
            &invite_expires_key(invite, expires_at),
            &[],
        )?;
    }
    Ok(())
}

/// `InviteCodeRepository::create`: the row the capture returns, minted with its options.
pub(crate) fn invite_create(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    code: &str,
    options: &CreateInviteCodeOptions,
    now: DateTime<Utc>,
) -> Result<InviteCode, StorageError> {
    let remaining_uses = match &options.remaining_uses {
        FieldUpdate::Absent => Some(1),
        FieldUpdate::Clear => None,
        FieldUpdate::Set(uses) => {
            if *uses < 0 {
                return Err(StorageError::InvalidArgument {
                    message: "invite_codes.remaining_uses must not be negative",
                });
            }
            Some(*uses)
        }
    };
    if invite_find_by_code(txn, databases, code)?.is_some() {
        return Err(StorageError::InvalidArgument {
            message: "invite code already exists",
        });
    }

    let invite = InviteCode {
        code: code.to_owned(),
        created_by: options.created_by,
        claimed_by: None,
        expires_at: options.expires_at.map(encoding::micros),
        remaining_uses,
        created_at: encoding::micros(now),
        updated_at: encoding::micros(now),
    };
    invite_write(txn, databases, &invite)?;
    Ok(invite)
}

/// `InviteCodeRepository::claim_code`: one conditional update, so exactly one caller wins.
pub(crate) fn invite_claim_code(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    code: &str,
    pubkey: &Pubkey,
    now: DateTime<Utc>,
) -> Result<bool, StorageError> {
    let Some(mut invite) = invite_find_by_code(txn, databases, code)? else {
        return Ok(false);
    };
    let now = encoding::micros(now);
    if invite
        .expires_at
        .is_some_and(|expires_at| expires_at <= now)
        || invite.remaining_uses.is_some_and(|uses| uses <= 0)
    {
        return Ok(false);
    }

    invite.remaining_uses = invite.remaining_uses.map(|uses| uses - 1);
    invite.claimed_by = invite.claimed_by.or(Some(*pubkey));
    invite.updated_at = now;
    let value = rows::encode("invite_codes", &invite)?;
    databases.invite_codes.put(txn, code.as_bytes(), &value)?;
    Ok(true)
}

/// `InviteCodeRepository::find_active_codes`: unexpired and claimable, newest first.
pub(crate) fn invite_find_active_codes(
    txn: &RoTxn<'_>,
    databases: &Databases,
    limit: u64,
    now: DateTime<Utc>,
) -> Result<Vec<InviteCode>, StorageError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let now = encoding::micros(now);
    let mut invites = Vec::new();
    for entry in databases.invite_codes_by_created_at.rev_iter(txn)? {
        let (key, _) = entry?;
        let code = text_from(&key[8..], "invite_codes_by_created_at")?;
        let Some(invite) = invite_find_by_code(txn, databases, code)? else {
            continue;
        };
        if invite
            .expires_at
            .is_some_and(|expires_at| expires_at <= now)
            || invite.remaining_uses.is_some_and(|uses| uses <= 0)
        {
            continue;
        }
        invites.push(invite);
        if invites.len() as u64 >= limit {
            break;
        }
    }
    Ok(invites)
}

/// `InviteCodeRepository::delete_expired_codes`.
pub(crate) fn invite_delete_expired(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    now: DateTime<Utc>,
) -> Result<u64, StorageError> {
    let now = encoding::micros(now);
    let mut expired = Vec::new();
    for entry in databases.invite_codes_by_expires_at.iter(txn)? {
        let (key, _) = entry?;
        let expires_at = encoding::i64_from_key(&key[..8])?;
        if expires_at > now.timestamp_micros() {
            break;
        }
        expired.push(text_from(&key[8..], "invite_codes_by_expires_at")?.to_owned());
    }

    let mut affected = 0;
    for code in expired {
        let Some(invite) = invite_find_by_code(txn, databases, &code)? else {
            continue;
        };
        databases.invite_codes.delete(txn, code.as_bytes())?;
        databases
            .invite_codes_by_created_at
            .delete(txn, &invite_created_key(&invite))?;
        if let Some(expires_at) = invite.expires_at {
            databases
                .invite_codes_by_expires_at
                .delete(txn, &invite_expires_key(&invite, expires_at))?;
        }
        affected += 1;
    }
    Ok(affected)
}

// ---------------------------------------------------------------------------------------
// DVM jobs.
// ---------------------------------------------------------------------------------------

fn dvm_status_key(job: &DvmJob, created_at: DateTime<Utc>) -> Result<Vec<u8>, StorageError> {
    let mut key = text_part(
        job.status.as_str(),
        "dvm_jobs_by_status_created_at",
        "status",
    )?;
    key.extend_from_slice(&stamp_key(created_at));
    key.extend_from_slice(job.id.as_bytes());
    Ok(key)
}

pub(crate) fn dvm_find_by_id(
    txn: &RoTxn<'_>,
    databases: &Databases,
    id: &EventId,
) -> Result<Option<DvmJob>, StorageError> {
    let Some(value) = databases.dvm_jobs.get(txn, id.as_bytes())? else {
        return Ok(None);
    };
    rows::decode("dvm_jobs", value).map(Some)
}

pub(super) fn dvm_write(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    job: &DvmJob,
    previous: Option<&DvmJob>,
) -> Result<(), StorageError> {
    let value = rows::encode("dvm_jobs", job)?;
    databases.dvm_jobs.put(txn, job.id.as_bytes(), &value)?;
    if let Some(previous) = previous {
        databases
            .dvm_jobs_by_status_created_at
            .delete(txn, &dvm_status_key(previous, previous.created_at)?)?;
    }
    databases
        .dvm_jobs_by_status_created_at
        .put(txn, &dvm_status_key(job, job.created_at)?, &[])?;
    Ok(())
}

/// `DvmJobRepository::create`: a submitted job with every optional column empty.
pub(crate) fn dvm_create(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    id: &EventId,
    requester: &Pubkey,
    kind: Kind,
    now: DateTime<Utc>,
) -> Result<DvmJob, StorageError> {
    if dvm_find_by_id(txn, databases, id)?.is_some() {
        return Err(StorageError::InvalidArgument {
            message: "dvm_jobs.id must not already exist",
        });
    }
    let now = encoding::micros(now);
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
    dvm_write(txn, databases, &job, None)?;
    Ok(job)
}

/// `DvmJobRepository::assign_worker`: a conditional update from `submitted`.
pub(crate) fn dvm_assign_worker(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    id: &EventId,
    worker_index: i32,
    now: DateTime<Utc>,
) -> Result<bool, StorageError> {
    let Some(mut job) = dvm_find_by_id(txn, databases, id)? else {
        return Ok(false);
    };
    if job.status != DvmJobStatus::Submitted {
        return Ok(false);
    }
    let previous = job.clone();
    let now = encoding::micros(now);
    job.worker_index = Some(worker_index);
    job.status = DvmJobStatus::PickedUp;
    job.picked_up_at = Some(now);
    job.updated_at = now;
    dvm_write(txn, databases, &job, Some(&previous))?;
    Ok(true)
}

/// `DvmJobRepository::update_status`: the `FieldUpdate` fields are applied by key presence.
pub(crate) fn dvm_update_status(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    update: &DvmJobUpdate,
    now: DateTime<Utc>,
) -> Result<Option<DvmJob>, StorageError> {
    let Some(mut job) = dvm_find_by_id(txn, databases, &update.id)? else {
        return Ok(None);
    };
    let previous = job.clone();
    let now = encoding::micros(now);
    job.status = update.status;
    job.updated_at = now;
    if update.status.is_terminal() {
        job.completed_at = Some(now);
    }
    match &update.result_event_id {
        FieldUpdate::Absent => {}
        FieldUpdate::Clear => job.result_event_id = None,
        FieldUpdate::Set(id) => job.result_event_id = Some(*id),
    }
    match &update.error {
        FieldUpdate::Absent => {}
        FieldUpdate::Clear => job.error = None,
        FieldUpdate::Set(error) => job.error = Some(error.clone()),
    }
    dvm_write(txn, databases, &job, Some(&previous))?;
    Ok(Some(job))
}

/// `DvmJobRepository::find_pending_jobs`: submitted and picked-up jobs, oldest first.
pub(crate) fn dvm_find_pending_jobs(
    txn: &RoTxn<'_>,
    databases: &Databases,
    limit: u64,
    kinds: Option<&[Kind]>,
) -> Result<Vec<DvmJob>, StorageError> {
    // Each status range runs in creation order, so the merge only needs the first `limit`
    // eligible rows of each: the backlog is not materialised for a small request.
    let take = usize::try_from(limit).unwrap_or(usize::MAX);
    if take == 0 {
        return Ok(Vec::new());
    }
    let mut jobs = Vec::new();
    for status in [DvmJobStatus::Submitted, DvmJobStatus::PickedUp] {
        let prefix = text_part(status.as_str(), "dvm_jobs_by_status_created_at", "status")?;
        let mut taken = 0;
        for entry in databases
            .dvm_jobs_by_status_created_at
            .prefix_iter(txn, &prefix)?
        {
            let (key, _) = entry?;
            let id = encoding::event_id_from(&key[key.len() - 32..])?;
            let Some(job) = dvm_find_by_id(txn, databases, &id)? else {
                continue;
            };
            if kinds.is_some_and(|kinds| !kinds.is_empty() && !kinds.contains(&job.kind)) {
                continue;
            }
            jobs.push(job);
            taken += 1;
            if taken >= take {
                break;
            }
        }
    }
    jobs.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    jobs.truncate(take);
    Ok(jobs)
}

// ---------------------------------------------------------------------------------------
// Reports.
// ---------------------------------------------------------------------------------------

fn report_key(id: i32) -> [u8; REPORT_ID_LEN] {
    encoding::i32_key(id)
}

fn report_event_key(report: &Report, event_id: &EventId) -> Vec<u8> {
    let mut key = event_id.as_bytes().to_vec();
    key.extend_from_slice(&report_key(report.id));
    key
}

fn report_created_key(report: &Report) -> Vec<u8> {
    let mut key = stamp_key(report.created_at).to_vec();
    key.extend_from_slice(&report_key(report.id));
    key
}

fn report_pubkey_key(report: &Report, pubkey: &Pubkey) -> Vec<u8> {
    let mut key = pubkey.as_bytes().to_vec();
    key.extend_from_slice(&report_key(report.id));
    key
}

fn report_load(
    txn: &RoTxn<'_>,
    databases: &Databases,
    id: i32,
) -> Result<Option<Report>, StorageError> {
    let Some(value) = databases.reports.get(txn, &report_key(id))? else {
        return Ok(None);
    };
    rows::decode("reports", value).map(Some)
}

/// Allocates the next `reports.id` from the `meta` sequence, which starts at 1.
fn next_report_id(txn: &mut RwTxn<'_>, databases: &Databases) -> Result<i32, StorageError> {
    let current: u64 = match databases.meta.get(txn, REPORT_SEQUENCE)? {
        Some(value) => rows::decode("meta", value)?,
        None => 0,
    };
    let next = current + 1;
    let value = rows::encode("meta", &next)?;
    databases.meta.put(txn, REPORT_SEQUENCE, &value)?;
    i32::try_from(next).map_err(|_| StorageError::ValueOutOfRange {
        column: "reports.id",
        value: next.to_string(),
    })
}

/// Raises the `reports.id` sequence to `id`, so a report the migration carried across cannot be
/// allocated again by a later `create`.
///
/// Never lowers it: a batch that carries no report passes `0` and leaves the sequence alone.
pub(super) fn raise_report_sequence(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    id: i32,
) -> Result<(), StorageError> {
    let wanted = u64::try_from(id).unwrap_or(0);
    let current: u64 = match databases.meta.get(txn, REPORT_SEQUENCE)? {
        Some(value) => rows::decode("meta", value)?,
        None => 0,
    };
    if wanted > current {
        let value = rows::encode("meta", &wanted)?;
        databases.meta.put(txn, REPORT_SEQUENCE, &value)?;
    }
    Ok(())
}

pub(super) fn report_write(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    report: &Report,
) -> Result<(), StorageError> {
    let value = rows::encode("reports", report)?;
    databases.reports.put(txn, &report_key(report.id), &value)?;
    databases
        .reports_by_event_id
        .put(txn, &report_event_key(report, &report.event_id), &[])?;
    if report.actionable {
        databases
            .reports_actionable_by_created_at
            .put(txn, &report_created_key(report), &[])?;
        if let Some(event_id) = &report.reported_event_id {
            databases.reports_actionable_event.put(
                txn,
                &report_event_key(report, event_id),
                &[],
            )?;
        }
        if let Some(pubkey) = &report.reported_pubkey {
            databases.reports_actionable_pubkey.put(
                txn,
                &report_pubkey_key(report, pubkey),
                &[],
            )?;
        }
    }
    Ok(())
}

/// `ReportRepository::create`: inserts the row and returns it with its generated id.
pub(crate) fn report_create(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    new: &NewReport,
    now: DateTime<Utc>,
) -> Result<Report, StorageError> {
    let report = Report {
        id: next_report_id(txn, databases)?,
        event_id: new.event_id,
        reporter_pubkey: new.reporter_pubkey,
        reported_pubkey: new.reported_pubkey,
        reported_event_id: new.reported_event_id,
        report_type: new.report_type,
        weight: new.weight,
        actionable: new.actionable,
        created_at: encoding::micros(now),
    };
    report_write(txn, databases, &report)?;
    Ok(report)
}

/// `ReportRepository::find_by_event_id`.
pub(crate) fn report_find_by_event_id(
    txn: &RoTxn<'_>,
    databases: &Databases,
    event_id: &EventId,
) -> Result<Vec<Report>, StorageError> {
    let mut reports = Vec::new();
    for entry in databases
        .reports_by_event_id
        .prefix_iter(txn, event_id.as_bytes())?
    {
        let (key, _) = entry?;
        let id = encoding::i32_from_key(&key[32..])?;
        if let Some(report) = report_load(txn, databases, id)? {
            reports.push(report);
        }
    }
    Ok(reports)
}

/// `ReportRepository::find_actionable`: actionable rows, newest first.
pub(crate) fn report_find_actionable(
    txn: &RoTxn<'_>,
    databases: &Databases,
    limit: u64,
) -> Result<Vec<Report>, StorageError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut reports = Vec::new();
    for entry in databases.reports_actionable_by_created_at.rev_iter(txn)? {
        let (key, _) = entry?;
        let id = encoding::i32_from_key(&key[8..])?;
        if let Some(report) = report_load(txn, databases, id)? {
            reports.push(report);
        }
        if reports.len() as u64 >= limit {
            break;
        }
    }
    Ok(reports)
}

/// One actionable target, as the deduplicating walk keys it.
type ActionableKey = (Option<[u8; 32]>, Option<[u8; 32]>);

/// `ReportRepository::find_actionable_targets`: every distinct target, deduplicated the way
/// the capture's `DISTINCT` does.
pub(crate) fn report_find_actionable_targets(
    txn: &RoTxn<'_>,
    databases: &Databases,
) -> Result<Vec<ActionableTarget>, StorageError> {
    let mut targets: BTreeSet<ActionableKey> = BTreeSet::new();
    for entry in databases.reports_actionable_by_created_at.iter(txn)? {
        let (key, _) = entry?;
        let id = encoding::i32_from_key(&key[8..])?;
        if let Some(report) = report_load(txn, databases, id)? {
            targets.insert((
                report.reported_pubkey.map(|pubkey| *pubkey.as_bytes()),
                report.reported_event_id.map(|id| *id.as_bytes()),
            ));
        }
    }
    Ok(targets
        .into_iter()
        .map(|(pubkey, event_id)| ActionableTarget {
            reported_pubkey: pubkey.map(Pubkey::from_byte_array),
            reported_event_id: event_id.map(EventId::from_byte_array),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use crate::repositories::ReportType;

    fn report() -> Report {
        Report {
            id: 7,
            event_id: EventId::from_byte_array([1; 32]),
            reporter_pubkey: Pubkey::from_byte_array([2; 32]),
            reported_pubkey: Some(Pubkey::from_byte_array([3; 32])),
            reported_event_id: Some(EventId::from_byte_array([4; 32])),
            report_type: ReportType::Spam,
            weight: 0.0,
            actionable: true,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn every_report_index_key_ends_with_the_id_width_the_codec_writes() {
        // The NIP-56 lookups seek `reports_actionable_*` by the target's prefix and the walks
        // read the id back from the tail, so the id's width is the one `report_key` writes: a
        // widening has to change this assertion and the reads together, never one of them.
        let report = report();
        assert_eq!(REPORT_ID_LEN, report_key(report.id).len());
        assert_eq!(
            report_event_key(&report, &report.event_id).len(),
            32 + REPORT_ID_LEN
        );
        assert_eq!(
            report_pubkey_key(&report, &report.reporter_pubkey).len(),
            32 + REPORT_ID_LEN
        );
        assert_eq!(report_created_key(&report).len(), 8 + REPORT_ID_LEN);
    }
}
