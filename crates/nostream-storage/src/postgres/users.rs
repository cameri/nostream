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

/// `upsert`: inserts the row or updates the fields the patch carries. `balance` and
/// `created_at` are never touched.
pub(crate) async fn upsert<'e, E>(executor: E, patch: &UserPatch) -> Result<u64, StorageError>
where
    E: Executor<'e, Database = Postgres>,
{
    let (sql, args) = upsert_statement(patch);

    Ok(EventQuery { sql, args }
        .into_query()
        .execute(executor)
        .await?
        .rows_affected())
}

/// The statement [`upsert`] runs.
///
/// A flag the patch leaves `Absent` is written `false` on the insert and left out of the
/// merge: a caller that only needs the row to exist must not clear an admission or a vanish
/// flag that is already there.
fn upsert_statement(patch: &UserPatch) -> (String, Args) {
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
        args.push(Arg::Bool(
            patch.is_admitted.value().copied().unwrap_or(false),
        )),
        args.push(Arg::Bool(
            patch.is_vanished.value().copied().unwrap_or(false),
        )),
        args.push(Arg::Timestamp(now)),
        args.push(Arg::Timestamp(now)),
    ];
    let mut merge = vec!["updated_at = excluded.updated_at".to_owned()];

    if patch.is_admitted.value().is_some() {
        merge.push("is_admitted = excluded.is_admitted".to_owned());
    }

    if patch.is_vanished.value().is_some() {
        merge.push("is_vanished = excluded.is_vanished".to_owned());
    }

    match patch.tos_accepted_at {
        // Absent leaves the column alone (knex skips `undefined`).
        FieldUpdate::Absent => {}
        // `null` in the capture's row: the column is written and the merge clears it.
        FieldUpdate::Clear => {
            columns.push("tos_accepted_at");
            values.push(args.push(Arg::NullNaiveTimestamp));
            merge.push("tos_accepted_at = excluded.tos_accepted_at".to_owned());
        }
        FieldUpdate::Set(tos_accepted_at) => {
            columns.push("tos_accepted_at");
            values.push(args.push(Arg::NaiveTimestamp(tos_accepted_at.naive_utc())));
            merge.push("tos_accepted_at = excluded.tos_accepted_at".to_owned());
        }
    }

    let sql = format!(
        "INSERT INTO users ({}) VALUES ({}) ON CONFLICT (pubkey) DO UPDATE SET {}",
        columns.join(", "),
        values.join(", "),
        merge.join(", ")
    );

    (sql, args)
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use nostream_core::Pubkey;

    fn patch(is_admitted: FieldUpdate<bool>, is_vanished: FieldUpdate<bool>) -> UserPatch {
        UserPatch {
            pubkey: Pubkey::from_byte_array([1; 32]),
            is_admitted,
            is_vanished,
            tos_accepted_at: FieldUpdate::Absent,
        }
    }

    /// An upsert that only needs the row to exist must not clear admission or a vanish flag.
    #[test]
    fn absent_flags_are_not_merged() {
        let (sql, _args) = upsert_statement(&patch(FieldUpdate::Absent, FieldUpdate::Absent));

        assert!(!sql.contains("is_admitted = excluded.is_admitted"), "{sql}");
        assert!(!sql.contains("is_vanished = excluded.is_vanished"), "{sql}");
        assert!(
            sql.contains("updated_at = excluded.updated_at"),
            "the row is still touched: {sql}"
        );
        assert!(
            sql.contains("(pubkey, is_admitted, is_vanished, updated_at, created_at)"),
            "a new row is written with the flags' defaults: {sql}"
        );
    }

    /// A patch that carries a flag still writes it, which is what admission and vanish writes
    /// need.
    #[test]
    fn carried_flags_are_merged() {
        let (sql, _args) = upsert_statement(&patch(FieldUpdate::Set(true), FieldUpdate::Set(true)));

        assert!(sql.contains("is_admitted = excluded.is_admitted"), "{sql}");
        assert!(sql.contains("is_vanished = excluded.is_vanished"), "{sql}");
    }
}
