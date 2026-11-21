//! `setup.ts`: the first-time bootstrap, and the `.env` it creates.
//!
//! The two questions are a line reader over stdin with an `IsTerminal` check rather than a
//! prompt crate (Assumption 6, D6), so the boxed prompts are plain lines and the answers are
//! what clack's were: an empty line accepts the default, and end of input is the cancel path.
//!
//! The `.env` rules are the capture's, byte for byte (`src/cli/commands/setup.ts:32-138`): the
//! file is copied from `.env.example` when absent; the `SECRET=` placeholder is the one value
//! replaced; a real secret is left alone; and the replacement keeps the line's trailing comment.

use std::io::{BufRead, IsTerminal, Write};
use std::path::Path;

use nostream_core::random::RandomSource;

use crate::app::Context;
use crate::bootstrap::{ensure_config_bootstrap, project_path};
use crate::commands::start::StartOptions;
use crate::config::CommandOutput;
use crate::error::CliError;

/// The value `.env.example` ships in place of a secret (`SECRET_PLACEHOLDER`, `setup.ts:14`).
pub const SECRET_PLACEHOLDER: &str = "change_me_to_something_long_and_random";

/// The length of the generated secret in bytes, which is 128 hex characters
/// (`randomBytes(64).toString('hex')`, `setup.ts:70`).
const GENERATED_SECRET_BYTES: usize = 64;

/// The parsed `setup` flags.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SetupOptions {
    /// `-y`/`--yes`: never prompt, and take the generated secret.
    pub yes: bool,
    /// `--start`: start the stack when the bootstrap finishes.
    pub start: bool,
}

/// Runs `setup` on a runtime the command owns.
pub fn run(context: &Context, options: &SetupOptions) -> Result<CommandOutput, CliError> {
    context.block_on(setup(context, options))
}

/// `runSetup`.
pub(crate) async fn setup(
    context: &Context,
    options: &SetupOptions,
) -> Result<CommandOutput, CliError> {
    let mut lines = vec!["Nostream setup".to_owned()];

    ensure_config_bootstrap(&context.cwd, &context.env)?;

    match ensure_env_file(context, options.yes)? {
        EnvOutcome::Written => {}
        EnvOutcome::Cancelled => {
            lines.push("Setup cancelled".to_owned());
            return Ok(CommandOutput::with_code(lines, 1));
        }
    }

    let should_start = if options.start {
        true
    } else if !options.yes && std::io::stdin().is_terminal() {
        match confirm_start()? {
            Some(answer) => answer,
            None => {
                lines.push("Setup cancelled".to_owned());
                return Ok(CommandOutput::with_code(lines, 1));
            }
        }
    } else {
        false
    };

    if !should_start {
        lines.push("Setup complete".to_owned());
        return Ok(CommandOutput::print(lines));
    }

    let started = crate::commands::start::start(context, &StartOptions::default(), &[]).await?;
    lines.push(if started.exit_code == 0 {
        "Setup complete".to_owned()
    } else {
        "Setup finished with errors".to_owned()
    });

    Ok(CommandOutput::with_code(lines, started.exit_code))
}

/// What `ensureEnvFile` decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnvOutcome {
    /// The file exists with a secret, or was given one.
    Written,
    /// The operator answered the prompt with a cancel.
    Cancelled,
}

/// `ensureEnvFile`: create `.env` from `.env.example` when absent, then replace the placeholder.
fn ensure_env_file(context: &Context, assume_yes: bool) -> Result<EnvOutcome, CliError> {
    let env_path = project_path(&context.cwd, &[".env"]);
    let example_path = project_path(&context.cwd, &[".env.example"]);

    if !env_path.exists() {
        if example_path.exists() {
            std::fs::copy(&example_path, &env_path).map_err(|error| {
                CliError::command(format!(
                    "unable to copy {}: {error}",
                    example_path.display()
                ))
            })?;
        } else {
            std::fs::write(&env_path, "").map_err(|error| {
                CliError::command(format!("unable to write {}: {error}", env_path.display()))
            })?;
        }
    }

    let current = std::fs::read_to_string(&env_path).map_err(|error| {
        CliError::command(format!("unable to read {}: {error}", env_path.display()))
    })?;

    if !needs_secret_replacement(read_env_secret(&current)) {
        return Ok(EnvOutcome::Written);
    }

    let Some(secret) = resolve_secret(context, assume_yes)? else {
        return Ok(EnvOutcome::Cancelled);
    };

    std::fs::write(&env_path, upsert_secret(&current, &secret)).map_err(|error| {
        CliError::command(format!("unable to write {}: {error}", env_path.display()))
    })?;

    Ok(EnvOutcome::Written)
}

/// `readEnvSecret`: the first `SECRET=` line's value, without its comment.
pub fn read_env_secret(content: &str) -> Option<String> {
    for line in content.split('\n') {
        let trimmed = line.trim_end_matches('\r').trim();

        if trimmed.is_empty() || trimmed.starts_with('#') || !trimmed.starts_with("SECRET=") {
            continue;
        }

        let raw = trimmed["SECRET=".len()..]
            .split('#')
            .next()
            .unwrap_or_default();
        return Some(raw.trim().to_owned());
    }

    None
}

/// `needsSecretReplacement`: absent or the placeholder.
fn needs_secret_replacement(secret: Option<String>) -> bool {
    match secret {
        None => true,
        Some(secret) => secret.is_empty() || secret == SECRET_PLACEHOLDER,
    }
}

/// `resolveSecret`: the environment, then the prompt, then 128 random hex characters.
fn resolve_secret(context: &Context, assume_yes: bool) -> Result<Option<String>, CliError> {
    if let Some(secret) = context
        .env
        .get("SECRET")
        .map(|value| value.trim().to_owned())
        && !secret.is_empty()
    {
        return Ok(Some(secret));
    }

    if !assume_yes && std::io::stdin().is_terminal() {
        return prompt_secret();
    }

    let bytes = nostream_core::random::SystemRandom
        .bytes(GENERATED_SECRET_BYTES)
        .map_err(|error| CliError::command(error.to_string()))?;

    Ok(Some(hex::encode(bytes)))
}

/// The `SECRET` question: a non-blank answer, and end of input is the cancel.
fn prompt_secret() -> Result<Option<String>, CliError> {
    println!("SECRET env var value (hex recommended)");
    print!("openssl rand -hex 128: ");
    let _ = std::io::stdout().flush();

    for line in std::io::stdin().lock().lines() {
        let line =
            line.map_err(|error| CliError::command(format!("unable to read the answer: {error}")))?;
        let answer = line.trim().to_owned();

        if answer.is_empty() {
            println!("SECRET is required");
            print!("openssl rand -hex 128: ");
            let _ = std::io::stdout().flush();
            continue;
        }

        return Ok(Some(answer));
    }

    Ok(None)
}

/// `Start relay now?`, whose empty answer is the capture's default of yes.
fn confirm_start() -> Result<Option<bool>, CliError> {
    print!("Start relay now? (Y/n) ");
    let _ = std::io::stdout().flush();

    let mut answer = String::new();
    let read = std::io::stdin().read_line(&mut answer);

    match read {
        Ok(0) => Ok(None),
        Ok(_) => {
            let answer = answer.trim().to_lowercase();
            Ok(Some(!matches!(answer.as_str(), "n" | "no")))
        }
        Err(error) => Err(CliError::command(format!(
            "unable to read the answer: {error}"
        ))),
    }
}

/// `upsertSecret`: the first `SECRET=` line replaced, its trailing comment kept, or a new line.
pub fn upsert_secret(content: &str, secret: &str) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut replaced = false;

    let next: Vec<String> = lines
        .into_iter()
        .map(|line| {
            if replaced {
                return line.to_owned();
            }

            let trimmed = line.trim();

            if !trimmed.starts_with("SECRET=") || trimmed.starts_with('#') {
                return line.to_owned();
            }

            replaced = true;
            let comment = match line.find('#') {
                Some(index) => line[index..].trim_end(),
                None => "",
            };

            if comment.is_empty() {
                format!("SECRET={secret}")
            } else {
                format!("SECRET={secret} {comment}")
            }
        })
        .collect();

    if replaced {
        return next.join("\n");
    }

    let mut next = next;

    match next.last() {
        Some(last) if last.is_empty() => {
            next.pop();
            next.push(format!("SECRET={secret}"));
            next.push(String::new());
        }
        Some(_) => next.push(format!("SECRET={secret}")),
        None => next.push(format!("SECRET={secret}")),
    }

    next.join("\n")
}

/// The file the bootstrap writes, which the tests read like the operator does.
pub fn env_path(cwd: &Path) -> std::path::PathBuf {
    project_path(cwd, &[".env"])
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn the_placeholder_is_read_as_the_secret_it_is() {
        let content = "A=1\nSECRET=change_me_to_something_long_and_random # Generate: openssl rand -hex 128\n";
        assert_eq!(
            read_env_secret(content).as_deref(),
            Some(SECRET_PLACEHOLDER)
        );
        assert!(needs_secret_replacement(read_env_secret(content)));
    }

    #[test]
    fn a_real_secret_is_left_alone() {
        assert!(!needs_secret_replacement(Some("real-secret".to_owned())));
        assert!(needs_secret_replacement(None));
        assert!(needs_secret_replacement(Some(String::new())));
    }

    #[test]
    fn the_upsert_keeps_the_comment_and_writes_one_line() {
        let content = "A=1\nSECRET=change_me_to_something_long_and_random # Generate: openssl rand -hex 128\nB=2\n";
        let next = upsert_secret(content, "abc");

        assert_eq!(
            next,
            "A=1\nSECRET=abc # Generate: openssl rand -hex 128\nB=2\n"
        );
        assert_eq!(
            next.matches("SECRET=").count(),
            1,
            "one SECRET= line, whatever the comment says"
        );
    }

    #[test]
    fn a_blank_secret_keeps_its_comment() {
        assert_eq!(
            upsert_secret("SECRET=   # existing comment\n", "abc"),
            "SECRET=abc # existing comment\n"
        );
    }

    #[test]
    fn a_missing_secret_line_is_appended() {
        assert_eq!(upsert_secret("A=1", "abc"), "A=1\nSECRET=abc");
    }
}
