//! `clean-db.ts`: the delete-list clean-up, as its own top-level command.
//!
//! The capture's parser is hand-written and its messages are the contract
//! (`src/clean-db.ts:97-159`), so this module parses the same way, prints the capture's
//! `HELP_TEXT` for `--help`, and selects rows with [`EventCleanCriteria`] — the same predicate
//! for the count and the delete (C2, V49).
//!
//! Every failure here is reported **bare**, with exit 1: the capture's own entry point catches
//! them all and prints them with `console.error` (`src/clean-db.ts:270-277`), so none of them
//! carries the `Error: ` prefix (V63 class B). The `NODE_ENV=production` warning is written
//! straight to stderr before the run, as the capture's `console.warn` is, and leaves the exit
//! code alone.

use std::io::IsTerminal;
use std::path::PathBuf;

use chrono::Utc;
use nostream_config::SettingsPaths;
use nostream_core::Kind;
use nostream_storage::repositories::EventCleanCriteria;

use crate::app::Context;
use crate::config::CommandOutput;
use crate::error::CliError;
use crate::store;

/// The capture's `HELP_TEXT` (`src/clean-db.ts:15-31`), with `nostream dev db:clean` replaced by
/// `nostream clean-db` on the five lines that name it (V53).
pub fn help_lines() -> Vec<String> {
    [
        "Usage: nostream clean-db [options]",
        "",
        "Options:",
        "  --all                  Delete all events.",
        "  --older-than=<days>    Delete events older than the given number of days.",
        "  --kinds=<1,7,4>        Delete events for specific kinds.",
        "  --dry-run              Show how many rows would be deleted without deleting them.",
        "  --force                Skip interactive confirmation prompt.",
        "  --help                 Show this help message.",
        "",
        "Examples:",
        "  nostream clean-db --all --dry-run",
        "  nostream clean-db --all --force",
        "  nostream clean-db --older-than=30 --force",
        "  nostream clean-db --older-than=30 --kinds=1,7,4 --dry-run",
    ]
    .map(str::to_owned)
    .to_vec()
}

/// The parsed `clean-db` arguments (`CleanDbOptions`, `src/clean-db.ts:9-16`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CleanDbOptions {
    pub all: bool,
    pub dry_run: bool,
    pub force: bool,
    pub help: bool,
    pub kinds: Vec<Kind>,
    pub older_than_days: Option<u64>,
    /// The store root, which the capture's `--older-than`/`--kinds` paths did not need because
    /// they always spoke to Postgres (R21).
    pub data_dir: Option<PathBuf>,
}

/// `parseCleanDbOptions`, case for case.
///
/// `--data-dir` is the one option the capture does not have: the port reads the settings' own
/// store, and the LMDB root has to be named (R21).
pub fn parse_args(args: &[String]) -> Result<CleanDbOptions, CliError> {
    let mut options = CleanDbOptions::default();
    let mut index = 0;

    while index < args.len() {
        let argument = &args[index];

        match argument.as_str() {
            "--all" => {
                options.all = true;
                index += 1;
            }
            "--dry-run" => {
                options.dry_run = true;
                index += 1;
            }
            "--force" => {
                options.force = true;
                index += 1;
            }
            "--help" | "-h" => {
                options.help = true;
                index += 1;
            }
            other if matches_option(other, "--older-than") => {
                let (value, next) = option_value(other, args, index)?;
                options.older_than_days = Some(parse_older_than_days(&value)?);
                index = next + 1;
            }
            other if matches_option(other, "--kinds") => {
                let (value, next) = option_value(other, args, index)?;
                options.kinds = parse_kinds(&value)?;
                index = next + 1;
            }
            other if matches_option(other, "--data-dir") => {
                let (value, next) = option_value(other, args, index)?;
                options.data_dir = Some(PathBuf::from(value));
                index = next + 1;
            }
            other => {
                return Err(CliError::reported_line(format!("Unknown option: {other}")));
            }
        }
    }

    if options.help {
        return Ok(options);
    }

    if !options.all && options.older_than_days.is_none() && options.kinds.is_empty() {
        return Err(CliError::reported_line(
            "Select a target with --all, --older-than, or --kinds",
        ));
    }

    if options.all && (options.older_than_days.is_some() || !options.kinds.is_empty()) {
        return Err(CliError::reported_line(
            "--all cannot be combined with --older-than or --kinds",
        ));
    }

    Ok(options)
}

/// `arg === option || arg.startsWith(\`${option}=\`)` (`src/clean-db.ts:93-95`): an option that
/// merely shares a prefix is not this option.
fn matches_option(argument: &str, option: &str) -> bool {
    argument == option
        || argument
            .strip_prefix(option)
            .is_some_and(|rest| rest.starts_with('='))
}

/// `getOptionValue`: an inline `=value` or the next argument, and `Missing value for <option>`
/// for neither.
fn option_value(
    argument: &str,
    args: &[String],
    index: usize,
) -> Result<(String, usize), CliError> {
    let option = argument.split('=').next().unwrap_or(argument);

    if let Some(inline) = argument.split_once('=').map(|(_, value)| value) {
        if inline.trim().is_empty() {
            return Err(CliError::reported_line(format!(
                "Missing value for {option}"
            )));
        }

        return Ok((inline.to_owned(), index));
    }

    match args.get(index + 1) {
        Some(next) if !next.starts_with("--") => Ok((next.clone(), index + 1)),
        _ => Err(CliError::reported_line(format!(
            "Missing value for {option}"
        ))),
    }
}

/// `parseOlderThanDays`: digits only, then a positive safe integer, one message for both.
fn parse_older_than_days(value: &str) -> Result<u64, CliError> {
    let days = value
        .bytes()
        .all(|byte| byte.is_ascii_digit())
        .then(|| value.parse::<u64>().ok())
        .flatten()
        .filter(|days| *days > 0);

    days.ok_or_else(|| CliError::reported_line("--older-than must be a positive integer"))
}

/// `parseKinds`: a comma-separated list of non-negative integers, deduplicated in order.
fn parse_kinds(value: &str) -> Result<Vec<Kind>, CliError> {
    let parts: Vec<&str> = value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();

    if parts.is_empty() {
        return Err(CliError::reported_line(
            "--kinds requires at least one kind",
        ));
    }

    let mut kinds: Vec<Kind> = Vec::new();

    for part in parts {
        let digits = part.bytes().all(|byte| byte.is_ascii_digit());
        let parsed = digits.then(|| part.parse::<u64>().ok()).flatten();

        let Some(kind) = parsed else {
            return Err(CliError::reported_line(
                "--kinds must be a comma-separated list of non-negative integers",
            ));
        };

        if !kinds.contains(&Kind(kind)) {
            kinds.push(Kind(kind));
        }
    }

    Ok(kinds)
}

/// Runs `clean-db` on a runtime the command owns.
pub fn run(context: &Context, args: &[String]) -> Result<CommandOutput, CliError> {
    let options = parse_args(args)?;

    if options.help {
        return Ok(CommandOutput::print(help_lines()));
    }

    if context
        .env
        .get("NODE_ENV")
        .is_some_and(|value| value == "production")
    {
        eprintln!(
            "WARNING: NODE_ENV=production detected. This operation permanently deletes data."
        );
    }

    context.block_on(clean(context, &options))
}

/// `runCleanDb`'s body over the configured store.
async fn clean(context: &Context, options: &CleanDbOptions) -> Result<CommandOutput, CliError> {
    let settings = crate::config::effective_settings(&SettingsPaths::resolve(&context.cwd))
        .map_err(|error| CliError::reported_line(error.to_string()))?;
    let opened = store::open(&settings, options.data_dir.as_deref(), &context.env)
        .await
        .map_err(|error| CliError::reported_line(error.to_string()))?;
    let events = opened.events();
    let criteria = options.criteria(Utc::now().timestamp());

    if options.dry_run {
        let every_row = EventCleanCriteria::default();
        let selected = if options.all { &every_row } else { &criteria };
        let matching = events
            .count_by_criteria(selected)
            .await
            .map_err(|error| CliError::reported_line(error.to_string()))?;

        return Ok(CommandOutput::print(vec![format!(
            "Dry run: {matching} events would be deleted."
        )]));
    }

    if !options.force {
        if !std::io::stdin().is_terminal() {
            return Err(CliError::reported_line(
                "Interactive confirmation is unavailable. Re-run with --force.",
            ));
        }

        if !confirm()? {
            return Ok(CommandOutput::with_code(
                vec!["Aborted. Confirmation text did not match DELETE.".to_owned()],
                1,
            ));
        }
    }

    if options.all {
        events
            .delete_all_events()
            .await
            .map_err(|error| CliError::reported_line(error.to_string()))?;

        return Ok(CommandOutput::print(vec!["Deleted all events.".to_owned()]));
    }

    let deleted = events
        .delete_by_criteria(&criteria)
        .await
        .map_err(|error| CliError::reported_line(error.to_string()))?;

    Ok(CommandOutput::print(vec![format!(
        "Deleted {deleted} events."
    )]))
}

impl CleanDbOptions {
    /// `applySelectiveFilters`: `created_at < now - days*86400` **and** `kind IN kinds`, with
    /// neither condition set selecting every row (V40, V49).
    pub fn criteria(&self, now_seconds: i64) -> EventCleanCriteria {
        EventCleanCriteria {
            before: self
                .older_than_days
                .and_then(|days| i64::try_from(days).ok())
                .map(|days| now_seconds - days * 86_400),
            kinds: (!self.kinds.is_empty()).then(|| self.kinds.clone()),
        }
    }
}

/// `askForConfirmation`: one line, trimmed, exactly `DELETE`. End of input is the cancel path
/// (`src/clean-db.ts:238-250`; AC48).
fn confirm() -> Result<bool, CliError> {
    print!("Type 'DELETE' to confirm: ");
    let _ = std::io::Write::flush(&mut std::io::stdout());

    let mut answer = String::new();
    let read = std::io::stdin().read_line(&mut answer);

    match read {
        Ok(0) => Ok(false),
        Ok(_) => Ok(answer.trim() == "DELETE"),
        Err(error) => Err(CliError::reported_line(format!(
            "unable to read the confirmation: {error}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|value| (*value).to_owned()).collect()
    }

    /// `test/unit/clean-db.spec.ts:5-95`'s ten cases, one per assertion group.
    #[test]
    fn the_parser_is_the_captures_case_for_case() {
        let all_force = parse_args(&args(&["--all", "--force"])).expect("all and force");
        assert!(all_force.all);
        assert!(all_force.force);
        assert!(all_force.kinds.is_empty());

        let selective = parse_args(&args(&["--older-than=7", "--kinds=1,7,1", "--dry-run"]))
            .expect("selective");
        assert_eq!(
            selective.kinds,
            vec![Kind(1), Kind(7)],
            "the kinds are deduplicated in order"
        );
        assert_eq!(selective.older_than_days, Some(7));
        assert!(selective.dry_run);

        let spaced = parse_args(&args(&["--older-than", "30", "--kinds", "1,7"])).expect("spaced");
        assert_eq!(spaced.older_than_days, Some(30));
        assert_eq!(spaced.kinds, vec![Kind(1), Kind(7)]);

        assert!(parse_args(&args(&["--help"])).expect("help alone").help);
    }

    #[test]
    fn the_parser_refuses_what_the_capture_refuses() {
        let message = |list: &[&str]| {
            parse_args(&args(list))
                .expect_err("the parser refuses this")
                .to_string()
        };

        assert_eq!(
            message(&["--force"]),
            "Select a target with --all, --older-than, or --kinds"
        );
        assert_eq!(
            message(&["--all", "--older-than=30"]),
            "--all cannot be combined with --older-than or --kinds"
        );
        assert_eq!(
            message(&["--all", "--kinds=1,7"]),
            "--all cannot be combined with --older-than or --kinds"
        );
        for value in ["--older-than=0", "--older-than=-1", "--older-than=abc"] {
            assert_eq!(message(&[value]), "--older-than must be a positive integer");
        }
        assert_eq!(message(&["--kinds="]), "Missing value for --kinds");
        assert_eq!(
            message(&["--kinds=1,abc"]),
            "--kinds must be a comma-separated list of non-negative integers"
        );
        assert_eq!(message(&["--unknown"]), "Unknown option: --unknown");
        assert_eq!(
            message(&["--older-than-days=7"]),
            "Unknown option: --older-than-days=7"
        );
        assert_eq!(
            message(&["--kinds-extra", "1,2,3"]),
            "Unknown option: --kinds-extra"
        );
    }

    #[test]
    fn the_criteria_carry_one_clock() {
        let options = parse_args(&args(&["--older-than=30", "--kinds=1,7"])).expect("selective");
        let now = 1_700_000_000;

        assert_eq!(
            options.criteria(now),
            EventCleanCriteria {
                before: Some(now - 30 * 86_400),
                kinds: Some(vec![Kind(1), Kind(7)]),
            }
        );

        let all = parse_args(&args(&["--all"])).expect("all");
        assert_eq!(all.criteria(now), EventCleanCriteria::default());
    }

    #[test]
    fn the_help_page_names_the_port_not_the_capture() {
        let lines = help_lines();

        assert!(lines[0].contains("nostream clean-db"));
        assert!(
            lines.iter().all(|line| !line.contains("dev db:clean")),
            "no line names the removed `dev` route"
        );
    }
}
