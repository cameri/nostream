//! `dev.ts`'s `docker:clean`, as the top-level `clean` the capture already had
//! (`src/cli/index.ts:184-188`): stop every overlay, then prune the two docker families.
//!
//! The confirmation the capture's `dev docker:clean` asks is already answered here
//! (`runDevDockerClean({ yes: true })`, V14), which is why this command has no `--yes`.
//! Each step answers the child's code, and a step that fails ends the run with it.

use crate::app::Context;
use crate::commands::stop::StopOptions;
use crate::config::CommandOutput;
use crate::error::CliError;

/// Runs `clean` on a runtime the command owns.
pub fn run(context: &Context) -> Result<CommandOutput, CliError> {
    context.block_on(clean(context))
}

/// `runDevDockerClean` with the confirmation already answered.
pub(crate) async fn clean(context: &Context) -> Result<CommandOutput, CliError> {
    let stopped = crate::commands::stop::stop(context, &StopOptions::every_overlay(), &[]).await?;

    if stopped.exit_code != 0 {
        return Ok(CommandOutput::with_code(Vec::new(), stopped.exit_code));
    }

    let pruned = docker(&["system", "prune", "-a", "-f"]).await?;

    if pruned != 0 {
        return Ok(CommandOutput::with_code(Vec::new(), pruned));
    }

    let pruned = docker(&["volume", "prune", "-f"]).await?;

    Ok(CommandOutput::with_code(Vec::new(), pruned))
}

/// One `docker <args>` run, inheriting the terminal, answering the child's code.
async fn docker(arguments: &[&str]) -> Result<u8, CliError> {
    let mut argv = vec!["docker".to_owned()];
    argv.extend(arguments.iter().map(|argument| (*argument).to_owned()));

    let code = nostream_services::process::run(&argv, &[])
        .await
        .map_err(|failure| CliError::command(failure.to_string()))?;

    Ok(u8::try_from(code).unwrap_or(1))
}
