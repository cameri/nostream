//! `invite.ts`: mint one NIP-43 invite code against the configured store.
//!
//! The capture always spoke to Postgres; the port speaks to the store the settings name (R13),
//! and the DB checks it does before connecting — no `DB_URI`/`DB_HOST` at all, and an
//! unreachable host — keep the capture's two messages, hint included
//! (`src/cli/commands/invite.ts:9-19,97-130`).
//!
//! `info.self` is the code's `createdBy`: hex as written, lowercased, or an `npub1…` decoded
//! through [`nostream_core::nip19`] (V23). A relay pubkey that is neither is `None`, which is
//! what the capture's `parseRelayPubkey` answers.

use std::path::PathBuf;

use chrono::{DateTime, SecondsFormat, Utc};
use nostream_config::SettingsPaths;
use nostream_core::EventStoreBackend;
use nostream_core::nip19;
use nostream_core::nip43::{generate_invite_code, resolve_invite_limits};
use nostream_storage::repositories::{CreateInviteCodeOptions, FieldUpdate, InviteCode};

use crate::app::Context;
use crate::config::CommandOutput;
use crate::error::CliError;
use crate::store;

/// The banner the capture prints when Postgres is missing or unreachable
/// (`INVITE_CLI_DB_HINT`, `src/cli/commands/invite.ts:16-19`).
pub const DB_HINT: &str =
    "If Nostream is running in Docker, Postgres is not published to the host. Run:
  docker compose exec nostream node src/cli/index.js invite create

If PostgreSQL is local, set DB_URI or DB_HOST (see .env.example).";

/// The page `invite` prints when it is given no subcommand (`inviteSubHelp.create`,
/// `src/cli/index.ts:95-97`), thrown as a usage failure at exit 2.
pub const INVITE_USAGE: &str =
    "Usage: nostream invite create [--uses N] [--expires-in <seconds>] [--json]";

/// The parsed `invite create` flags.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InviteOptions {
    /// The raw `--uses` value, validated here: the capture's message is its own.
    pub uses: Option<String>,
    /// The raw `--expires-in` value, in seconds.
    pub expires_in: Option<String>,
    pub json: bool,
    pub data_dir: Option<PathBuf>,
}

/// A minted code, in the capture's key order (`serializeInviteCode`,
/// `src/cli/commands/invite.ts:132-141`).
#[derive(Debug, serde::Serialize)]
struct MintedCode {
    code: String,
    #[serde(rename = "createdBy")]
    created_by: Option<String>,
    #[serde(rename = "claimedBy")]
    claimed_by: Option<String>,
    #[serde(rename = "expiresAt")]
    expires_at: Option<String>,
    #[serde(rename = "remainingUses")]
    remaining_uses: Option<i32>,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

/// Runs `invite create` on a runtime the command owns.
pub fn run(context: &Context, options: &InviteOptions) -> Result<CommandOutput, CliError> {
    let uses = positive(&options.uses, "--uses must be a positive integer")?;
    let expires_in = positive(
        &options.expires_in,
        "--expires-in must be a positive integer (seconds)",
    )?;

    context.block_on(create(context, options, uses, expires_in))
}

/// The capture's two argument checks (`src/cli/index.ts:316-321`): a safe integer of at least
/// one, one message for every refusal.
fn positive(raw: &Option<String>, message: &str) -> Result<Option<u64>, CliError> {
    let Some(raw) = raw else {
        return Ok(None);
    };

    let digits = raw
        .bytes()
        .all(|byte| byte.is_ascii_digit())
        .then(|| raw.parse::<u64>().ok())
        .flatten()
        .filter(|value| *value >= 1);

    digits.map(Some).ok_or_else(|| CliError::usage(message))
}

/// `runInviteCreate`.
async fn create(
    context: &Context,
    options: &InviteOptions,
    uses: Option<u64>,
    expires_in: Option<u64>,
) -> Result<CommandOutput, CliError> {
    let settings = crate::config::effective_settings(&SettingsPaths::resolve(&context.cwd))
        .map_err(|error| CliError::command(error.to_string()))?;

    let created_by = relay_pubkey(settings.info.self_.as_deref())?;
    let now = Utc::now();
    let nip43 = settings.nip43.as_ref();
    let limits = resolve_invite_limits(
        nip43.and_then(|nip43| nip43.default_max_uses),
        nip43.and_then(|nip43| nip43.invite_code_expiry_seconds),
        now.timestamp(),
    )
    .map_err(|error| CliError::command(error.to_string()))?;

    let remaining_uses = match uses {
        Some(uses) => {
            i32::try_from(uses).map_err(|_| CliError::usage("--uses must be a positive integer"))?
        }
        None => i32::try_from(limits.remaining_uses)
            .map_err(|_| CliError::command("remainingUses must be a positive integer"))?,
    };

    let expires_at = match expires_in {
        Some(seconds) => {
            Some(now + chrono::Duration::seconds(i64::try_from(seconds).unwrap_or(i64::MAX)))
        }
        None => limits
            .expires_at
            .map(|seconds| DateTime::<Utc>::from_timestamp(seconds, 0))
            .unwrap_or(None),
    };

    let opened = open(context, &settings, options.data_dir.as_deref()).await?;
    let code = generate_invite_code().map_err(|error| CliError::command(error.to_string()))?;

    let invite = opened
        .invites()
        .create(
            &code,
            &CreateInviteCodeOptions {
                expires_at,
                remaining_uses: FieldUpdate::Set(remaining_uses),
                created_by,
            },
        )
        .await
        .map_err(|error| CliError::command(error.to_string()))?;

    if options.json {
        return json(&invite);
    }

    Ok(CommandOutput::print(vec![
        invite.code.clone(),
        format!(
            "uses: {}",
            invite
                .remaining_uses
                .map_or_else(|| "unlimited".to_owned(), |uses| uses.to_string())
        ),
        format!(
            "expires: {}",
            iso(invite.expires_at).unwrap_or_else(|| "never".to_owned())
        ),
    ]))
}

/// Opens the configured store, with the capture's two Postgres refusals around it.
async fn open(
    context: &Context,
    settings: &nostream_config::Settings,
    data_dir: Option<&std::path::Path>,
) -> Result<store::Opened, CliError> {
    let postgres = store::selected_backend(settings) == EventStoreBackend::Postgres;

    if postgres && store::postgres_url(&context.env).is_none() {
        return Err(CliError::command(format!(
            "PostgreSQL is not configured (set DB_URI or DB_HOST).\n\n{DB_HINT}"
        )));
    }

    store::open(settings, data_dir, &context.env)
        .await
        .map_err(|error| {
            let message = error.to_string();

            if postgres {
                CliError::command(format!("{message}\n\n{DB_HINT}"))
            } else {
                CliError::command(message)
            }
        })
}

/// `parseRelayPubkey`: hex as written (lowercased), an `npub1…` decoded, or nothing.
fn relay_pubkey(value: Option<&str>) -> Result<Option<nostream_core::Pubkey>, CliError> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    let is_hex = value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());

    if is_hex {
        return lower_hex_pubkey(value).map(Some);
    }

    if value.to_lowercase().starts_with("npub1") {
        let hex = nip19::decode_npub_hex(value)
            .map_err(|_| CliError::command("info.self npub did not decode to a 32-byte pubkey"))?;

        return lower_hex_pubkey(&hex).map(Some);
    }

    Ok(None)
}

/// One 64-character hex pubkey, as the domain type accepts it.
fn lower_hex_pubkey(value: &str) -> Result<nostream_core::Pubkey, CliError> {
    let lowered = value.to_lowercase();
    lowered
        .parse::<nostream_core::Pubkey>()
        .map_err(|_| CliError::command("createdBy must be a 64-character hex pubkey"))
}

/// `JSON.stringify(serializeInviteCode(invite))`: one line, the capture's key order.
fn json(invite: &InviteCode) -> Result<CommandOutput, CliError> {
    let payload = MintedCode {
        code: invite.code.clone(),
        created_by: invite.created_by.map(|pubkey| pubkey.to_string()),
        claimed_by: invite.claimed_by.map(|pubkey| pubkey.to_string()),
        expires_at: iso(invite.expires_at),
        remaining_uses: invite.remaining_uses,
        created_at: iso(Some(invite.created_at)).unwrap_or_default(),
        updated_at: iso(Some(invite.updated_at)).unwrap_or_default(),
    };

    let rendered = serde_json::to_string(&payload)
        .map_err(|error| CliError::command(format!("unable to render the code: {error}")))?;

    Ok(CommandOutput::print(vec![rendered]))
}

/// `Date#toISOString()`: milliseconds, always, in UTC.
fn iso(value: Option<DateTime<Utc>>) -> Option<String> {
    value.map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn the_use_counts_are_positive_integers() {
        assert_eq!(
            positive(&None, "--uses must be a positive integer").unwrap(),
            None
        );
        assert_eq!(
            positive(&Some("3".to_owned()), "--uses must be a positive integer").unwrap(),
            Some(3)
        );

        for bad in ["0", "-1", "abc", "1.5", ""] {
            let error = positive(&Some(bad.to_owned()), "--uses must be a positive integer")
                .expect_err("refused");
            assert_eq!(error.to_string(), "--uses must be a positive integer");
        }
    }

    #[test]
    fn the_npub_pair_from_the_fixture_decodes() {
        assert_eq!(
            relay_pubkey(Some(
                "npub1yt5qf5nw694k3k6jt8ncgj0fdk4463jv3arshk37kxnsgeljc7fsmhwffw"
            ))
            .unwrap()
            .map(|pubkey| pubkey.to_string()),
            Some("22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793".to_owned())
        );
    }

    #[test]
    fn a_hex_pubkey_is_lowercased_and_an_unknown_form_is_nothing() {
        let upper = "22E804D26ED16B68DB5259E78449E96DAB5D464C8F470BDA3EB1A70467F2C793";
        assert_eq!(
            relay_pubkey(Some(upper))
                .unwrap()
                .map(|pubkey| pubkey.to_string()),
            Some(upper.to_lowercase())
        );
        assert_eq!(
            relay_pubkey(Some("replace-with-your-pubkey-in-hex")).unwrap(),
            None
        );
    }

    #[test]
    fn a_malformed_npub_is_refused_with_the_captures_message() {
        let error = relay_pubkey(Some("npub1invalid")).expect_err("refused");
        assert_eq!(
            error.to_string(),
            "info.self npub did not decode to a 32-byte pubkey"
        );
    }

    #[test]
    fn a_date_renders_to_iso_milliseconds() {
        let at = DateTime::<Utc>::from_timestamp(1_700_000_000, 500_000_000).expect("a date");
        assert_eq!(iso(Some(at)).as_deref(), Some("2023-11-14T22:13:20.500Z"));
        assert_eq!(iso(None), None);
    }
}
