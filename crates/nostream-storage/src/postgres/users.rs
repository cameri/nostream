//! `UserRepository` against Postgres. Mirrors `src/repositories/user-repository.ts`.

use chrono::{DateTime, Utc};
use nostream_core::Pubkey;
use sqlx::postgres::Postgres;
use sqlx::{Executor, Row};

use super::{Arg, Args, EventQuery};
use crate::error::StorageError;
use crate::repositories::{FieldUpdate, User, UserPatch};

/// `findByPubkey`: the full row as the capture's `fromDBUser` maps it.
pub(crate) async fn find_by_pubkey<'e, E>(
    executor: E,
    pubkey: &Pubkey,
) -> Result<Option<User>, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let pubkey_slot = args.push(Arg::Bytes(pubkey.as_bytes().to_vec()));
    let sql = format!(
        "SELECT pubkey, COALESCE(is_admitted, false) AS is_admitted, \
         COALESCE(is_vanished, false) AS is_vanished, COALESCE(balance, 0) AS balance, \
         created_at, updated_at FROM users WHERE pubkey = {pubkey_slot}"
    );
    let row = EventQuery { sql, args }
        .into_query()
        .fetch_optional(executor)
        .await?;

    row.as_ref().map(super::rows::user).transpose()
}

/// `upsert`: inserts the row or updates admission, the vanished flag and `updated_at`, and
/// `tos_accepted_at` only when the patch carries it. `balance` and `created_at` are never
/// touched.
pub(crate) async fn upsert<'e, E>(executor: E, patch: &UserPatch) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let mut args = Args::default();
    let mut columns = vec![
        "pubkey",
        "is_admitted",
        "is_vanished",
        "updated_at",
        "created_at",
    ];
    let mut values = vec![
        args.push(Arg::Bytes(patch.pubkey.as_bytes().to_vec())),
        args.push(Arg::Bool(patch.is_admitted)),
        args.push(Arg::Bool(patch.is_vanished)),
        args.push(Arg::Timestamp(now)),
        args.push(Arg::Timestamp(now)),
    ];
    let mut merge = String::from(
        "is_admitted = excluded.is_admitted, is_vanished = excluded.is_vanished, \
         updated_at = excluded.updated_at",
    );
    if let FieldUpdate::Set(tos_accepted_at) = patch.tos_accepted_at {
        columns.push("tos_accepted_at");
        values.push(args.push(Arg::NaiveTimestamp(tos_accepted_at.naive_utc())));
        merge.push_str(", tos_accepted_at = excluded.tos_accepted_at");
    }

    let sql = format!(
        "INSERT INTO users ({}) VALUES ({}) ON CONFLICT (pubkey) DO UPDATE SET {merge}",
        columns.join(", "),
        values.join(", ")
    );

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected())
}

/// `getBalanceByPubkey`: the stored balance, `0` when no row exists.
pub(crate) async fn get_balance_by_pubkey<'e, E>(
    executor: E,
    pubkey: &Pubkey,
) -> Result<i64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let pubkey_slot = args.push(Arg::Bytes(pubkey.as_bytes().to_vec()));
    let sql = format!("SELECT balance FROM users WHERE pubkey = {pubkey_slot} LIMIT 1");
    let row = EventQuery { sql, args }
        .into_query()
        .fetch_optional(executor)
        .await?;

    match row {
        None => Ok(0),
        Some(row) => Ok(row.try_get::<i64, _>("balance")?),
    }
}

/// `upsertVanishState`: inserts a minimal row or updates only the vanished flag.
pub(crate) async fn upsert_vanish_state<'e, E>(
    executor: E,
    pubkey: &Pubkey,
    vanished: bool,
) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let now = Utc::now();
    let mut args = Args::default();
    let pubkey_slot = args.push(Arg::Bytes(pubkey.as_bytes().to_vec()));
    let vanished_slot = args.push(Arg::Bool(vanished));
    let now_slot = args.push(Arg::Timestamp(now));
    let created_slot = args.push(Arg::Timestamp(now));
    let sql = format!(
        "INSERT INTO users (pubkey, is_admitted, balance, is_vanished, created_at, updated_at) \
         VALUES ({pubkey_slot}, false, 0, {vanished_slot}, {now_slot}, {created_slot}) \
         ON CONFLICT (pubkey) DO UPDATE SET is_vanished = excluded.is_vanished, \
         updated_at = excluded.updated_at"
    );

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected())
}

/// `admitUser`: the schema function, which asserts a serializable transaction.
pub(crate) async fn admit_user<'e, E>(
    executor: E,
    pubkey: &Pubkey,
    admitted_at: DateTime<Utc>,
) -> Result<(), StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let pubkey_slot = args.push(Arg::Bytes(pubkey.as_bytes().to_vec()));
    let admitted_slot = args.push(Arg::NaiveTimestamp(admitted_at.naive_utc()));
    let sql = format!("SELECT admit_user({pubkey_slot}, {admitted_slot})");

    EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?;
    Ok(())
}

/// `revokeAdmission`: a targeted update so unrelated columns are never clobbered.
pub(crate) async fn revoke_admission<'e, E>(
    executor: E,
    pubkey: &Pubkey,
) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let mut args = Args::default();
    let pubkey_slot = args.push(Arg::Bytes(pubkey.as_bytes().to_vec()));
    let now_slot = args.push(Arg::Timestamp(Utc::now()));
    let sql = format!(
        "UPDATE users SET is_admitted = false, updated_at = {now_slot} WHERE pubkey = {pubkey_slot}"
    );

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected())
}
