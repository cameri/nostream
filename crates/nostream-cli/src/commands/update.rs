//! `update.ts`: stop, stash, pull, reapply, start — in that order, with the step's own message.
//!
//! The interesting half is the stash (`src/cli/commands/update.ts:7-9`): whether one was created
//! is the **absence** of `No local changes to save` in the stash's output, and that decides
//! whether a `stash pop` runs at all (V13). Every failure prints the capture's message and
//! returns that step's code.

use nostream_services::process::{self, CapturedResult, SpawnFailure};

use crate::app::Context;
use crate::commands::start::StartOptions;
use crate::commands::stop::StopOptions;
use crate::config::CommandOutput;
use crate::error::CliError;

/// The stash's message (`update.ts:20`).
const STASH_MESSAGE: &str = "nostream-cli-update";

/// The line whose absence means a stash was created (`update.ts:7-9`).
const NOTHING_TO_SAVE: &str = "No local changes to save";

/// `git is not installed`: what a missing binary is reported as.
const GIT_MISSING: &str = "Update failed: git is not installed";

/// The `git` argv a run uses.
fn git(arguments: &[&str]) -> Vec<String> {
    let mut argv = vec!["git".to_owned()];
    argv.extend(arguments.iter().map(|argument| (*argument).to_owned()));
    argv
}

/// Runs `update` on a runtime the command owns.
pub fn run(context: &Context, passthrough: &[String]) -> Result<CommandOutput, CliError> {
    context.block_on(update(context, passthrough))
}

/// `runUpdate`.
pub(crate) async fn update(
    context: &Context,
    passthrough: &[String],
) -> Result<CommandOutput, CliError> {
    let stopped = crate::commands::stop::stop(context, &StopOptions::every_overlay(), &[]).await?;

    if stopped.exit_code != 0 {
        return Err(failed(
            "Update failed while stopping relay",
            stopped.exit_code,
        ));
    }

    let stashed = process::capture(&git(&["stash", "push", "-u", "-m", STASH_MESSAGE]), None).await;

    let stash_output = match &stashed {
        CapturedResult::Exited {
            code,
            stdout,
            stderr,
        } => {
            if *code != 0 {
                return Err(failed(
                    "Update failed while stashing local changes",
                    u8::try_from(*code).unwrap_or(1),
                ));
            }

            format!("{stdout}\n{stderr}")
        }
        // A killed `git stash push` has no exit code and prints neither of the two lines
        // `was_stash_created` reads, so the old fall-through answered "created" and the run went
        // on to pop a stash it had not made. The capture's `ok === false` branch fails the step,
        // and with no code to report it answers the capture's own `code ?? 1`.
        CapturedResult::Signalled { .. } => {
            return Err(failed("Update failed while stashing local changes", 1));
        }
        CapturedResult::Failed { failure, .. } => {
            return Err(match failure {
                SpawnFailure::NotFound { .. } => CliError::reported_line(GIT_MISSING),
                _ => CliError::reported_line("Update failed while stashing local changes"),
            });
        }
        CapturedResult::TimedOut => {
            return Err(CliError::reported_line(
                "Update failed while stashing local changes",
            ));
        }
    };

    let stash_created = was_stash_created(&stash_output);

    let pulled = run_git(&git(&["pull"])).await?;

    if pulled != 0 {
        if !stash_created {
            return Err(failed(
                "Update failed while pulling latest changes.",
                pulled,
            ));
        }

        let restored = run_git(&git(&["stash", "pop"])).await?;

        if restored == 0 {
            return Err(failed(
                "Update failed while pulling latest changes. Restored stashed local changes.",
                pulled,
            ));
        }

        return Err(failed(
            "Update failed while pulling latest changes, and restoring stashed local changes also failed. Run `git stash list` then `git stash pop` manually.",
            restored,
        ));
    }

    if stash_created {
        let reapplied = run_git(&git(&["stash", "pop"])).await?;

        if reapplied != 0 {
            return Err(failed(
                "Update pulled latest changes, but reapplying stashed changes failed",
                reapplied,
            ));
        }
    }

    let started =
        crate::commands::start::start(context, &StartOptions::default(), passthrough).await?;

    if started.exit_code != 0 {
        return Err(failed(
            "Update finished pull, but restart failed",
            started.exit_code,
        ));
    }

    Ok(CommandOutput::default())
}

/// `runCommand('git', …)`: the child's stdio is the terminal's, and its code is the answer.
async fn run_git(argv: &[String]) -> Result<u8, CliError> {
    match process::run(argv, &[]).await {
        Ok(code) => Ok(u8::try_from(code).unwrap_or(1)),
        Err(SpawnFailure::NotFound { .. }) => Err(CliError::reported_line(GIT_MISSING)),
        Err(failure) => Err(CliError::reported_line(format!(
            "Update failed while running git: {failure}"
        ))),
    }
}

/// `wasStashCreated`: a stash exists unless git says there was nothing to save.
pub fn was_stash_created(output: &str) -> bool {
    !output.contains(NOTHING_TO_SAVE)
}

/// One reported failure with the code the step answered.
fn failed(message: &str, exit_code: u8) -> CliError {
    CliError::Reported {
        lines: vec![message.to_owned()],
        exit_code,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    /// The stash's own output is the whole boundary: one string means a stash exists.
    #[test]
    fn a_stash_is_created_unless_git_says_there_is_nothing_to_save() {
        assert!(was_stash_created("Saved working directory\n"));
        assert!(!was_stash_created("No local changes to save\n"));
        assert!(!was_stash_created("No local changes to save\n"));
    }
}
