//! The NIP-05 rows the ops panel lists and the re-verification `POST …/:pubkey/reverify`
//! runs. Mirrors `src/utils/admin-ops-nip05.ts` and `src/utils/nip05-reverification.ts`.

use chrono::{DateTime, Utc};
use nostream_config::Settings;
use nostream_core::Pubkey;
use nostream_core::nip05::{VerificationOutcome, verify};
use nostream_storage::repositories::Nip05Verification;
use serde::Serialize;

use crate::error::AdminError;
use crate::state::AdminState;

/// `DEFAULT_NIP05_VERIFY_EXPIRATION_MS` (`src/utils/nip05.ts:21`).
pub const DEFAULT_VERIFY_EXPIRATION_MS: u64 = 604_800_000;

/// The list's default page size (`DEFAULT_LIMIT`).
pub const DEFAULT_LIMIT: u64 = 50;

/// The list's page-size cap (`MAX_LIMIT`).
pub const MAX_LIMIT: u64 = 200;

/// The record set the console page materialises before it filters and pages: the store lists
/// the newest this many checks, and the page's own `limit` (200 at most) and `offset` select
/// from them.
///
/// shortcut: the filters and the total are computed in memory over at most this many records,
/// upgrade when the store can list by domain, verified state and failure count itself.
pub const LIST_RECORDS_CAP: u64 = 2_000;

/// `getNip05VerifyExpirationMs`.
pub fn verify_expiration_ms(settings: &Settings) -> u64 {
    settings
        .nip05
        .as_ref()
        .and_then(|nip05| nip05.verify_expiration)
        .unwrap_or(DEFAULT_VERIFY_EXPIRATION_MS)
}

/// `isNip05VerificationStale`.
pub fn is_stale(verification: &Nip05Verification, expiration_ms: u64, now_ms: u64) -> bool {
    if !verification.is_verified {
        return true;
    }
    let Some(last_verified_at) = verification.last_verified_at else {
        return true;
    };
    let verified_ms = last_verified_at.timestamp_millis();
    let now = i64::try_from(now_ms).unwrap_or(i64::MAX);
    now.saturating_sub(verified_ms) > i64::try_from(expiration_ms).unwrap_or(i64::MAX)
}

/// One row of `GET /ops/nip05-verifications` (`AdminNip05VerificationAdminRow`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nip05Row {
    pub pubkey: String,
    pub nip05: String,
    pub domain: String,
    pub is_verified: bool,
    pub failure_count: i32,
    pub last_verified_at: Option<String>,
    pub last_checked_at: String,
    pub stale: bool,
}

fn iso8601(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `toAdminNip05Row`.
pub fn to_row(verification: &Nip05Verification, expiration_ms: u64, now_ms: u64) -> Nip05Row {
    Nip05Row {
        pubkey: verification.pubkey.to_string(),
        nip05: verification.nip05.clone(),
        domain: verification.domain.clone(),
        is_verified: verification.is_verified,
        failure_count: verification.failure_count,
        last_verified_at: verification.last_verified_at.map(iso8601),
        last_checked_at: iso8601(verification.last_checked_at),
        stale: is_stale(verification, expiration_ms, now_ms),
    }
}

/// The list query (`listForAdmin`'s filters).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListQuery {
    pub limit: u64,
    pub offset: u64,
    pub domain: Option<String>,
    pub verified: Option<bool>,
    pub stale: Option<bool>,
    pub min_failures: Option<u32>,
}

impl ListQuery {
    /// Clamps the paging parameters the way the capture does: `limit` to `[1, 200]`,
    /// `offset` to at least zero.
    pub fn from_params(
        limit: Option<u64>,
        offset: Option<u64>,
        domain: Option<String>,
        verified: Option<bool>,
        stale: Option<bool>,
        min_failures: Option<u32>,
    ) -> Self {
        Self {
            limit: limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
            offset: offset.unwrap_or(0),
            domain: domain.filter(|domain| !domain.trim().is_empty()),
            verified,
            stale,
            min_failures,
        }
    }
}

/// The page of rows and its total, newest check first.
pub async fn list_for_admin(
    state: &AdminState,
    settings: &Settings,
    query: &ListQuery,
) -> Result<(Vec<Nip05Row>, u64), AdminError> {
    let expiration_ms = verify_expiration_ms(settings);
    let now_ms = state.clock().now_ms();
    let mut records = state
        .stores()
        .nip05
        .list_verifications(LIST_RECORDS_CAP)
        .await?;

    records.retain(|record| {
        query
            .domain
            .as_ref()
            .is_none_or(|domain| record.domain.eq_ignore_ascii_case(domain.trim()))
            && query
                .verified
                .is_none_or(|verified| record.is_verified == verified)
            && query
                .stale
                .is_none_or(|stale| is_stale(record, expiration_ms, now_ms) == stale)
            && query.min_failures.is_none_or(|min_failures| {
                record.failure_count >= i32::try_from(min_failures).unwrap_or(i32::MAX)
            })
    });

    let total = records.len() as u64;
    records.sort_by_key(|record| std::cmp::Reverse(record.last_checked_at));

    let rows = records
        .iter()
        .skip(usize::try_from(query.offset).unwrap_or(usize::MAX))
        .take(usize::try_from(query.limit).unwrap_or(usize::MAX))
        .map(|record| to_row(record, expiration_ms, now_ms))
        .collect();

    Ok((rows, total))
}

/// `reverifyNip05Verification`: verify, apply the outcome, upsert, and only then answer.
///
/// Every outcome is saved, with the capture's own rule (`buildMetadataVerification`,
/// `src/handlers/event-message-handler.ts:800-870`): `verified` clears the failure count and
/// stamps `lastVerifiedAt`; `mismatch`/`invalid` are definitive and unverify the row;
/// `error` is transient, so the row keeps its `isVerified`/`lastVerifiedAt` and only the
/// failure count and check time move. A non-`Verified` outcome is the caller's `502` (R10),
/// answered after the save so the next maintenance pass sees the failure.
pub async fn reverify(
    state: &AdminState,
    record: &Nip05Verification,
) -> Result<Nip05Verification, AdminError> {
    let outcome = verify(state.fetch(), &record.nip05, &record.pubkey.to_string()).await;

    let now_ms = state.clock().now_ms();
    let now = DateTime::<Utc>::from_timestamp(
        i64::try_from(now_ms / 1000).unwrap_or(i64::MAX),
        u32::try_from((now_ms % 1000) * 1_000_000).unwrap_or(0),
    )
    .unwrap_or_else(Utc::now);

    let mut updated = record.clone();
    updated.last_checked_at = now;
    updated.updated_at = now;

    match &outcome {
        VerificationOutcome::Verified => {
            updated.is_verified = true;
            updated.last_verified_at = Some(now);
            updated.failure_count = 0;
        }
        VerificationOutcome::Mismatch | VerificationOutcome::Invalid { .. } => {
            updated.is_verified = false;
            updated.last_verified_at = None;
            updated.failure_count = updated.failure_count.saturating_add(1);
        }
        VerificationOutcome::Error { .. } => {
            updated.failure_count = updated.failure_count.saturating_add(1);
        }
    }

    state.stores().nip05.upsert(&updated).await?;

    if matches!(outcome, VerificationOutcome::Verified) {
        Ok(updated)
    } else {
        Err(AdminError::Internal("Re-verification failed".to_owned()))
    }
}

/// Parses a `:pubkey` path segment the way `pubkeySchema` does.
pub fn parse_pubkey(value: &str) -> Option<Pubkey> {
    value.parse::<Pubkey>().ok()
}
