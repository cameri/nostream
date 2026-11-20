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
///
/// The envelope wraps the whole command, validations included: the capture decides JSON mode
/// from the options object before it runs anything, so a refused `--uses` is enveloped too.
pub fn run(context: &Context, options: &InviteOptions) -> Result<CommandOutput, CliError> {
    create_from_arguments(context, options).map_err(|error| envelope(options.json, error))
}

/// The command's body before the envelope: the two argument checks, then `runInviteCreate`.
fn create_from_arguments(
    context: &Context,
    options: &InviteOptions,
) -> Result<CommandOutput, CliError> {
    let uses = positive(&options.uses, "--uses must be a positive integer")?;
    let expires_in = positive(
        &options.expires_in,
        "--expires-in must be a positive integer (seconds)",
    )?;

    context.block_on(create(context, options, uses, expires_in))
}

/// The capture's two argument checks (`src/cli/index.ts:316-321`): a **safe** integer of at
/// least one, one message for every refusal. Above `Number.MAX_SAFE_INTEGER` the capture refuses
/// before its arithmetic, and so does this: the value used to reach `Duration::seconds`, which
/// panics past its own bound (Amendment 3).
fn positive(raw: &Option<String>, message: &str) -> Result<Option<u64>, CliError> {
    let Some(raw) = raw else {
        return Ok(None);
    };

    let digits = raw
        .bytes()
        .all(|byte| byte.is_ascii_digit())
        .then(|| raw.parse::<u64>().ok())
        .flatten()
        .filter(|value| (1..=crate::MAX_SAFE_INTEGER).contains(value));

    digits.map(Some).ok_or_else(|| CliError::usage(message))
}

/// A failure of a command that accepted `--json`, in the capture's envelope: its handler derives
/// JSON mode from the options object, so a thrown usage failure is `code: 2` and a thrown plain
/// one `code: 1` (`src/cli/index.ts:116-135`).
fn envelope(json: bool, error: CliError) -> CliError {
    if !json {
        return error;
    }

    match error {
        CliError::Usage(message) => CliError::json(message, 2),
        CliError::Command(message) | CliError::Config(message) => CliError::json(message, 1),
        CliError::Json { .. } => error,
        other => other,
    }
}

/// `now + seconds`, refused with the capture's usage message when no instant can hold it.
/// `Duration`'s constructors panic past their own bound, so the value is turned into one that
/// fits before it is added (an `i64::MAX` `--expires-in` used to exit 101 here).
fn expiry(now: DateTime<Utc>, seconds: u64) -> Result<DateTime<Utc>, CliError> {
    let message = "--expires-in must be a positive integer (seconds)";

    i64::try_from(seconds)
        .ok()
        .and_then(chrono::Duration::try_seconds)
        .and_then(|duration| now.checked_add_signed(duration))
        .ok_or_else(|| CliError::usage(message))
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
        Some(seconds) => Some(expiry(now, seconds)?),
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

    /// `Number.isSafeInteger` is the bound (`src/cli/index.ts:316-321`); past it the value used
    /// to reach `Duration::seconds` and panicked (Amendment 3).
    #[test]
    fn the_bounds_are_the_captures_safe_integers() {
        for bad in [
            "9007199254740992",
            "9223372036854775807",
            "18446744073709551615",
        ] {
            let error = positive(
                &Some(bad.to_owned()),
                "--expires-in must be a positive integer (seconds)",
            )
            .expect_err("refused");
            assert_eq!(
                error.to_string(),
                "--expires-in must be a positive integer (seconds)"
            );
        }

        assert_eq!(
            positive(
                &Some("9007199254740991".to_owned()),
                "--expires-in must be a positive integer (seconds)"
            )
            .unwrap(),
            Some(9_007_199_254_740_991)
        );
    }

    /// A value past what a date can hold is the capture's usage refusal, not a panic.
    #[test]
    fn an_expiry_no_date_can_hold_is_refused() {
        let now = DateTime::<Utc>::from_timestamp(1_700_000_000, 0).expect("a date");

        assert_eq!(
            expiry(now, 600).unwrap(),
            now + chrono::Duration::seconds(600)
        );

        for seconds in [9_007_199_254_740_991, 9_223_372_036_854_775_807] {
            let error = expiry(now, seconds).expect_err("refused");
            assert_eq!(
                error.to_string(),
                "--expires-in must be a positive integer (seconds)"
            );
        }
    }

    /// The envelope is the class's: a usage failure is code 2, a thrown command one code 1, and
    /// without `--json` the error is untouched (`src/cli/index.ts:116-135`).
    #[test]
    fn a_json_failure_takes_the_envelope_with_its_classs_code() {
        let usage = envelope(true, CliError::usage("a usage failure"));
        assert!(matches!(usage, CliError::Json { code: 2, .. }), "{usage:?}");

        let command = envelope(true, CliError::command("a thrown failure"));
        assert!(
            matches!(command, CliError::Json { code: 1, .. }),
            "{command:?}"
        );

        let plain = envelope(false, CliError::usage("a usage failure"));
        assert!(matches!(plain, CliError::Usage(_)), "{plain:?}");
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
