//! `info.ts`: the relay's NIP-11 identity, the onion name and the runtime's two numbers.
//!
//! The nine text lines, the `--json` payload's key set and its order, and the two hostname
//! modes are the capture's (`src/cli/commands/info.ts:131-254`). The event count is the store's
//! live-row count inside a one-second connect bound, and the uptime is the container's start
//! time read from `docker compose ps -q` and `docker inspect`, each inside the same bound: a
//! number this process cannot learn is reported as missing, never as a failure.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use nostream_config::{Settings, SettingsPaths};
use nostream_core::Filter;
use nostream_relay::relay_key::RelayKeySource;
use nostream_services::process;

use crate::app::Context;
use crate::bootstrap::{i2p_keys_path, onion_key_path, tor_hostname_path};
use crate::config::CommandOutput;
use crate::error::CliError;
use crate::store;

/// The bound the capture puts on the event count's connection and on each docker probe
/// (`src/cli/commands/info.ts:35,42,66,78`).
const PROBE_BUDGET: Duration = Duration::from_millis(1_000);

/// The parsed `info` flags.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InfoOptions {
    pub tor_hostname: bool,
    pub i2p_hostname: bool,
    pub json: bool,
    /// The LMDB store root, which the command needs when the settings select that backend.
    pub data_dir: Option<PathBuf>,
}

/// The `--json` payload, in the capture's key order (V17).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    version: &'static str,
    relay: RelayPayload,
    tor: TorPayload,
    runtime: RuntimePayload,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayPayload {
    name: String,
    url: String,
    pubkey: String,
    signing_pubkey: Option<String>,
    payments_enabled: bool,
    payment_processor: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TorPayload {
    hostname: Option<String>,
    onion_private_key_path: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePayload {
    event_count: Option<u64>,
    uptime_seconds: Option<u64>,
}

#[derive(Debug, serde::Serialize)]
struct TorHostnamePayload {
    #[serde(rename = "torHostname")]
    tor_hostname: String,
}

#[derive(Debug, serde::Serialize)]
struct I2pHostnamesPayload {
    #[serde(rename = "i2pHostnames")]
    i2p_hostnames: Vec<String>,
}

/// Runs `info` on a runtime the command owns.
pub fn run(context: &Context, options: &InfoOptions) -> Result<CommandOutput, CliError> {
    context.block_on(info(context, options))
}

/// `runInfo`.
pub(crate) async fn info(
    context: &Context,
    options: &InfoOptions,
) -> Result<CommandOutput, CliError> {
    let settings = settings(context).map_err(|error| error.enveloped(options.json))?;
    let payload = payload(context, &settings, options.data_dir.as_deref()).await;

    if options.tor_hostname {
        return tor_hostname(&payload, options.json);
    }

    if options.i2p_hostname {
        return i2p_hostname(context, options.json).await;
    }

    if options.json {
        return json_value(&payload);
    }

    let payments = if payload.relay.payments_enabled {
        format!(
            "enabled ({})",
            payload.relay.payment_processor.as_deref().unwrap_or("n/a")
        )
    } else {
        "disabled".to_owned()
    };

    Ok(CommandOutput::print(vec![
        format!("Nostream v{}", payload.version),
        format!("Relay: {} ({})", payload.relay.name, payload.relay.url),
        format!("Pubkey: {}", payload.relay.pubkey),
        format!(
            "Signing pubkey (NIP-11 self): {}",
            payload
                .relay
                .signing_pubkey
                .as_deref()
                .unwrap_or("unavailable (SECRET not set)")
        ),
        format!("Payments: {payments}"),
        format!(
            "Tor hostname: {}",
            payload.tor.hostname.as_deref().unwrap_or("not found")
        ),
        format!("Onion key path: {}", payload.tor.onion_private_key_path),
        format!(
            "Events: {}",
            payload
                .runtime
                .event_count
                .map_or_else(|| "unavailable".to_owned(), |count| count.to_string())
        ),
        format!("Uptime: {}", format_uptime(payload.runtime.uptime_seconds)),
    ]))
}

/// `getInfoPayload`.
async fn payload(context: &Context, settings: &Settings, data_dir: Option<&Path>) -> Payload {
    let hostname = std::fs::read_to_string(tor_hostname_path(&context.cwd))
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty());

    let (event_count, uptime_seconds) =
        join(event_count(settings, data_dir, context), uptime_seconds()).await;

    let signing_pubkey = RelayKeySource::from_values(
        context.env.get("RELAY_PRIVATE_KEY"),
        context.env.get("SECRET"),
    )
    .try_public_key(&settings.info.relay_url)
    .map(|key| key.to_string());

    Payload {
        version: env!("CARGO_PKG_VERSION"),
        relay: RelayPayload {
            name: settings.info.name.clone(),
            url: settings.info.relay_url.clone(),
            pubkey: settings.info.pubkey.clone(),
            signing_pubkey,
            payments_enabled: settings
                .payments
                .as_ref()
                .is_some_and(|payments| payments.enabled),
            payment_processor: settings.payments.as_ref().and_then(|payments| {
                serde_json::to_value(payments.processor)
                    .ok()
                    .and_then(|name| name.as_str().map(str::to_owned))
            }),
        },
        tor: TorPayload {
            hostname,
            onion_private_key_path: onion_key_path(&context.cwd, &context.env)
                .display()
                .to_string(),
        },
        runtime: RuntimePayload {
            event_count,
            uptime_seconds,
        },
    }
}

/// The settings the daemon would read, with the document's failures thrown like the capture's
/// `loadMergedSettings`.
fn settings(context: &Context) -> Result<Settings, CliError> {
    let paths = SettingsPaths::resolve(&context.cwd);
    crate::config::effective_settings(&paths).map_err(|error| CliError::command(error.to_string()))
}

/// `getEventCount`: the live rows, or `None` when the store cannot answer inside the bound.
async fn event_count(
    settings: &Settings,
    data_dir: Option<&Path>,
    context: &Context,
) -> Option<u64> {
    let opened = store::open_within(settings, data_dir, &context.env, PROBE_BUDGET).await?;
    opened
        .events()
        .count_by_filters(&[Filter::default()])
        .await
        .ok()
}

/// The payload's two numbers are read concurrently, as the capture's `Promise.all` does.
async fn join<A: Future, B: Future>(left: A, right: B) -> (A::Output, B::Output) {
    tokio::join!(left, right)
}

/// `getRelayUptimeSeconds`: the container's start time, or `None` when docker cannot answer.
async fn uptime_seconds() -> Option<u64> {
    let listed = process::capture(
        &[
            "docker".to_owned(),
            "compose".to_owned(),
            "ps".to_owned(),
            "-q".to_owned(),
            "nostream".to_owned(),
        ],
        Some(PROBE_BUDGET),
    )
    .await;

    if listed.code() != Some(0) {
        return None;
    }

    let container = listed.stdout().trim();
    if container.is_empty() {
        return None;
    }

    let inspected = process::capture(
        &[
            "docker".to_owned(),
            "inspect".to_owned(),
            "--format".to_owned(),
            "{{.State.StartedAt}}".to_owned(),
            container.to_owned(),
        ],
        Some(PROBE_BUDGET),
    )
    .await;

    if inspected.code() != Some(0) {
        return None;
    }

    let started: DateTime<Utc> = DateTime::parse_from_rfc3339(inspected.stdout().trim())
        .ok()?
        .with_timezone(&Utc);
    let seconds = (Utc::now() - started).num_seconds().max(0);

    u64::try_from(seconds).ok()
}

/// `formatUptime` (`src/cli/commands/info.ts:93-115`): `Nd Nh Nm Ns` with leading zero units
/// omitted, and `unavailable` for a number this process could not learn.
pub fn format_uptime(uptime_seconds: Option<u64>) -> String {
    let Some(total) = uptime_seconds else {
        return "unavailable".to_owned();
    };

    let days = total / 86_400;
    let hours = (total % 86_400) / 3_600;
    let minutes = (total % 3_600) / 60;
    let seconds = total % 60;

    let mut segments = Vec::new();
    if days > 0 {
        segments.push(format!("{days}d"));
    }
    if hours > 0 || days > 0 {
        segments.push(format!("{hours}h"));
    }
    if minutes > 0 || hours > 0 || days > 0 {
        segments.push(format!("{minutes}m"));
    }
    segments.push(format!("{seconds}s"));

    segments.join(" ")
}

/// `--tor-hostname`, in its text and `--json` forms.
fn tor_hostname(payload: &Payload, json: bool) -> Result<CommandOutput, CliError> {
    let Some(hostname) = payload.tor.hostname.clone() else {
        return Err(if json {
            CliError::json(
                "Tor hostname not found. Start with `nostream start --tor` first.",
                1,
            )
        } else {
            CliError::reported_line(
                "Tor hostname not found. Start with `nostream start --tor` first.",
            )
        });
    };

    if json {
        return json_value(&TorHostnamePayload {
            tor_hostname: hostname,
        });
    }

    Ok(CommandOutput::print(vec![hostname]))
}

/// `--i2p-hostname`: the `.b32.i2p` names a docker shim prints, else the capture's guidance.
async fn i2p_hostname(context: &Context, json: bool) -> Result<CommandOutput, CliError> {
    let keys_file = i2p_keys_path(&context.cwd);

    if !keys_file.is_file() {
        let expected = keys_file.display().to_string();
        return Err(if json {
            CliError::json(
                format!(
                    "I2P destination keys not found. Is the i2pd container running? Expected: {expected}"
                ),
                1,
            )
        } else {
            CliError::reported(vec![
                "I2P destination keys not found. Is the i2pd container running?".to_owned(),
                format!("Expected: {expected}"),
            ])
        });
    }

    let answer = process::capture(
        &[
            "docker".to_owned(),
            "exec".to_owned(),
            "i2pd".to_owned(),
            "wget".to_owned(),
            "-qO-".to_owned(),
            "http://127.0.0.1:7070/?page=i2p_tunnels".to_owned(),
        ],
        None,
    )
    .await;

    let hostnames = b32_hostnames(&format!("{}\n{}", answer.stdout(), answer.stderr()));

    if !hostnames.is_empty() {
        if json {
            return json_value(&I2pHostnamesPayload {
                i2p_hostnames: hostnames,
            });
        }

        return Ok(CommandOutput::print(hostnames));
    }

    if json {
        return json_value(&serde_json::json!({
            "i2pHostnames": [],
            "keysFile": keys_file.display().to_string(),
            "guidance": {
                "webConsoleUrl": "http://127.0.0.1:7070/?page=i2p_tunnels",
                "consoleQueryCommand": LIVE_CONSOLE_QUERY,
            },
        }));
    }

    Ok(CommandOutput::print(vec![
        format!("I2P destination keys exist at: {}", keys_file.display()),
        String::new(),
        "To find your nostream .b32.i2p address, use one of these methods:".to_owned(),
        "  1. Open the i2pd web console: http://127.0.0.1:7070/?page=i2p_tunnels".to_owned(),
        "     (published by docker-compose.i2p.yml, bound to 127.0.0.1 only)".to_owned(),
        "  2. Query the console from inside the container:".to_owned(),
        "     docker exec i2pd wget -qO- 'http://127.0.0.1:7070/?page=i2p_tunnels' \\".to_owned(),
        "       | grep -oE '[a-z2-7]{52}\\.b32\\.i2p' | sort -u".to_owned(),
    ]))
}

/// The console query the capture's guidance prints (`src/cli/commands/info.ts:202`).
const LIVE_CONSOLE_QUERY: &str = "docker exec i2pd wget -qO- 'http://127.0.0.1:7070/?page=i2p_tunnels' | grep -oE '[a-z2-7]{52}\\.b32\\.i2p' | sort -u";

/// The `[a-z2-7]{52}\.b32\.i2p` names in `text`, deduplicated in the order they first appear —
/// the capture's `new Set(text.match(/…/g))`.
fn b32_hostnames(text: &str) -> Vec<String> {
    const SUFFIX: &[u8] = b".b32.i2p";
    const ADDRESS_LENGTH: usize = 52;
    const TOTAL: usize = ADDRESS_LENGTH + 8;

    let bytes = text.as_bytes();
    let mut names: Vec<String> = Vec::new();
    let mut index = 0;

    while index + TOTAL <= bytes.len() {
        let address = &bytes[index..index + ADDRESS_LENGTH];
        let is_address = address
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || (b'2'..=b'7').contains(byte));

        if is_address && &bytes[index + ADDRESS_LENGTH..index + TOTAL] == SUFFIX {
            if let Ok(name) = std::str::from_utf8(&bytes[index..index + TOTAL])
                && !names.iter().any(|seen| seen == name)
            {
                names.push(name.to_owned());
            }
            index += TOTAL;
        } else {
            index += 1;
        }
    }

    names
}

/// One `--json` value: `JSON.stringify(value, null, 2)` on stdout, exit 0.
fn json_value<T: serde::Serialize>(value: &T) -> Result<CommandOutput, CliError> {
    let rendered = serde_json::to_string_pretty(value)
        .map_err(|error| CliError::command(format!("unable to render the payload: {error}")))?;
    Ok(CommandOutput::print(vec![rendered]))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn the_uptime_format_omits_leading_zero_units() {
        assert_eq!(format_uptime(None), "unavailable");
        assert_eq!(format_uptime(Some(0)), "0s");
        assert_eq!(format_uptime(Some(59)), "59s");
        assert_eq!(format_uptime(Some(60)), "1m 0s");
        assert_eq!(format_uptime(Some(90)), "1m 30s");
        assert_eq!(format_uptime(Some(3_600)), "1h 0m 0s");
        assert_eq!(format_uptime(Some(90_061)), "1d 1h 1m 1s");
    }

    #[test]
    fn the_b32_names_are_the_addresses_a_console_prints() {
        let address = "a".repeat(52);
        let text = format!("noise {address}.b32.i2p and {address}.b32.i2p\n");
        assert_eq!(b32_hostnames(&text), vec![format!("{address}.b32.i2p")]);
    }

    #[test]
    fn a_name_of_the_wrong_length_is_not_an_address() {
        let short = "a".repeat(51);
        assert!(b32_hostnames(&format!("{short}.b32.i2p")).is_empty());
    }
}
