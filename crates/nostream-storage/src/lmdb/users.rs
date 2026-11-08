//! `UserRepository` against LMDB. Mirrors `src/repositories/user-repository.ts`.
//!
//! A user row is one value in the `users` database, keyed by the 32-byte pubkey. Every write
//! is one whole write transaction, so `admit_user` and the balance credit are atomic against
//! every other database.

use chrono::{DateTime, Utc};
use heed::{RoTxn, RwTxn};
use nostream_core::Pubkey;

use super::Databases;
use super::encoding;
use super::events;
use super::rows::{self, StoredUser};
use crate::error::StorageError;
use crate::repositories::{FieldUpdate, User, UserPatch};

/// The stored row of one pubkey.
pub(crate) fn load(
    txn: &RoTxn<'_>,
    databases: &Databases,
    pubkey: &Pubkey,
) -> Result<Option<StoredUser>, StorageError> {
    let Some(value) = databases.users.get(txn, pubkey.as_bytes())? else {
        return Ok(None);
    };
    rows::decode("users", value).map(Some)
}

/// Writes one user row, preserving nothing the caller did not supply.
pub(crate) fn store(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    stored: &StoredUser,
) -> Result<(), StorageError> {
    let value = rows::encode("users", stored)?;
    databases.users.put(txn, stored.pubkey.as_bytes(), &value)?;
    Ok(())
}

/// `findByPubkey`: the full row as the capture's `fromDBUser` maps it.
pub(crate) fn find_by_pubkey(
    txn: &RoTxn<'_>,
    databases: &Databases,
    pubkey: &Pubkey,
) -> Result<Option<User>, StorageError> {
    Ok(load(txn, databases, pubkey)?.map(StoredUser::user))
}

/// `upsert`: the flags the patch carries and `updated_at`, plus `tos_accepted_at` only when the
/// patch carries it. A flag the patch leaves `Absent` is `false` on a new row and left alone on
/// an existing one, as the Postgres merge does. `balance` and `created_at` are never touched.
pub(crate) fn upsert(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    patch: &UserPatch,
    now: DateTime<Utc>,
) -> Result<u64, StorageError> {
    let mut stored = match load(txn, databases, &patch.pubkey)? {
        Some(stored) => stored,
        None => StoredUser::new(patch.pubkey, encoding::micros(now)),
    };
    if let Some(is_admitted) = patch.is_admitted.value() {
        stored.is_admitted = *is_admitted;
    }
    if let Some(is_vanished) = patch.is_vanished.value() {
        stored.is_vanished = *is_vanished;
    }
    stored.updated_at = encoding::micros(now);
    match patch.tos_accepted_at {
        FieldUpdate::Absent => {}
        FieldUpdate::Clear => stored.tos_accepted_at = None,
        FieldUpdate::Set(value) => stored.tos_accepted_at = Some(encoding::micros(value)),
    }
    store(txn, databases, &stored)?;
    Ok(1)
}

/// `getBalanceByPubkey`: the stored balance, `0` when no row exists.
pub(crate) fn get_balance_by_pubkey(
    txn: &RoTxn<'_>,
    databases: &Databases,
    pubkey: &Pubkey,
) -> Result<i64, StorageError> {
    Ok(load(txn, databases, pubkey)?.map_or(0, |stored| stored.balance))
}

/// `upsertVanishState`: inserts a minimal row or updates only the vanished flag.
pub(crate) fn upsert_vanish_state(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    pubkey: &Pubkey,
    vanished: bool,
    now: DateTime<Utc>,
) -> Result<u64, StorageError> {
    let mut stored = match load(txn, databases, pubkey)? {
        Some(stored) => stored,
        None => StoredUser::new(*pubkey, encoding::micros(now)),
    };
    stored.is_vanished = vanished;
    stored.updated_at = encoding::micros(now);
    store(txn, databases, &stored)?;
    Ok(1)
}

/// The capture's `isVanished`: the stored flag, or one hydrated from a live vanish request.
pub(crate) fn is_vanished(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    pubkey: &Pubkey,
    now: DateTime<Utc>,
) -> Result<bool, StorageError> {
    if let Some(stored) = load(txn, databases, pubkey)? {
        return Ok(stored.is_vanished);
    }
    let vanished = events::has_active_request_to_vanish(txn, databases, pubkey)?;
    upsert_vanish_state(txn, databases, pubkey, vanished, now)?;
    Ok(vanished)
}

/// `admitUser`: the schema function's upsert, which a write transaction makes atomic.
pub(crate) fn admit_user(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    pubkey: &Pubkey,
    admitted_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<(), StorageError> {
    let mut stored = match load(txn, databases, pubkey)? {
        Some(stored) => stored,
        None => StoredUser::new(*pubkey, encoding::micros(now)),
    };
    stored.is_admitted = true;
    stored.tos_accepted_at = Some(encoding::micros(admitted_at));
    stored.updated_at = encoding::micros(now);
    store(txn, databases, &stored)
}

/// `revokeAdmission`: a targeted update so unrelated columns are never clobbered.
pub(crate) fn revoke_admission(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    pubkey: &Pubkey,
    now: DateTime<Utc>,
) -> Result<u64, StorageError> {
    let Some(mut stored) = load(txn, databases, pubkey)? else {
        return Ok(0);
    };
    stored.is_admitted = false;
    stored.updated_at = encoding::micros(now);
    store(txn, databases, &stored)?;
    Ok(1)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use crate::lmdb::LmdbBackend;
    use crate::repositories::UserRepository;

    fn patch(
        pubkey: Pubkey,
        is_admitted: FieldUpdate<bool>,
        is_vanished: FieldUpdate<bool>,
    ) -> UserPatch {
        UserPatch {
            pubkey,
            is_admitted,
            is_vanished,
            tos_accepted_at: FieldUpdate::Absent,
        }
    }

    /// A new row takes the capture's column defaults for the flags the patch does not carry.
    #[tokio::test]
    async fn a_new_row_writes_false_for_a_flag_the_patch_leaves_absent() {
        let directory = tempfile::tempdir().expect("tempdir");
        let backend = LmdbBackend::open(directory.path())
            .await
            .expect("the store opens");
        let pubkey = Pubkey::from_byte_array([1; 32]);

        backend
            .upsert(&patch(pubkey, FieldUpdate::Absent, FieldUpdate::Absent))
            .await
            .expect("the upsert");

        let user = backend
            .find_by_pubkey(&pubkey)
            .await
            .expect("the row")
            .expect("a row");
        assert!(!user.is_admitted);
        assert!(!user.is_vanished);
    }

    /// An upsert that only needs the row to exist must not clear an admission or a vanish flag
    /// that is already there, which is what the Postgres merge's omitted assignments do.
    #[tokio::test]
    async fn a_flag_the_patch_leaves_absent_keeps_the_stored_value() {
        let directory = tempfile::tempdir().expect("tempdir");
        let backend = LmdbBackend::open(directory.path())
            .await
            .expect("the store opens");
        let pubkey = Pubkey::from_byte_array([2; 32]);

        backend
            .upsert(&patch(
                pubkey,
                FieldUpdate::Set(true),
                FieldUpdate::Set(true),
            ))
            .await
            .expect("the upsert");
        backend
            .upsert(&patch(pubkey, FieldUpdate::Absent, FieldUpdate::Absent))
            .await
            .expect("the upsert");

        let user = backend
            .find_by_pubkey(&pubkey)
            .await
            .expect("the row")
            .expect("a row");
        assert!(user.is_admitted);
        assert!(user.is_vanished);
    }
}
