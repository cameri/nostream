//! `stop.ts`: stop the Docker Compose stack, selecting the overlays the flags name.
//!
//! The capture's default is the interesting half (`src/cli/commands/stop.ts:9`): **no** overlay
//! flag means *all four*, because a stack started with `--tor` must still stop when the operator
//! types plain `stop`.

use crate::app::Context;
use crate::compose::run_compose;
use crate::config::CommandOutput;
use crate::error::CliError;

/// The parsed `stop` flags.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StopOptions {
    pub tor: bool,
    pub i2p: bool,
    pub nginx: bool,
    pub local: bool,
    pub all: bool,
}

impl StopOptions {
    /// Every overlay, which `update` and `clean` ask for.
    pub fn every_overlay() -> Self {
        Self {
            all: true,
            ..Self::default()
        }
    }
}

/// The overlay files `stop` names, base file first.
pub fn compose_files(options: &StopOptions) -> Vec<String> {
    let include_all =
        options.all || (!options.tor && !options.i2p && !options.nginx && !options.local);

    let mut files = vec!["docker-compose.yml".to_owned()];

    if include_all || options.tor {
        files.push("docker-compose.tor.yml".to_owned());
    }
    if include_all || options.i2p {
        files.push("docker-compose.i2p.yml".to_owned());
    }
    if include_all || options.nginx {
        files.push("docker-compose.nginx.yml".to_owned());
    }
    if include_all || options.local {
        files.push("docker-compose.local.yml".to_owned());
    }

    files
}

/// Runs `stop` on a runtime the command owns.
pub fn run(
    context: &Context,
    options: &StopOptions,
    passthrough: &[String],
) -> Result<CommandOutput, CliError> {
    context.block_on(stop(context, options, passthrough))
}

/// `runStop`: `docker compose -f … down …`, answering the child's exit code.
pub(crate) async fn stop(
    context: &Context,
    options: &StopOptions,
    passthrough: &[String],
) -> Result<CommandOutput, CliError> {
    let files = compose_files(options);
    let mut args = vec!["down".to_owned()];
    args.extend(passthrough.iter().cloned());

    let named: Vec<&str> = files.iter().map(String::as_str).collect();
    let code = run_compose(&context.cwd, &named, &args, &[]).await?;
    Ok(CommandOutput::with_code(
        Vec::new(),
        u8::try_from(code).unwrap_or(1),
    ))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    /// Every overlay file `stop` can name, in the order it names them.
    fn all() -> Vec<String> {
        [
            "docker-compose.yml",
            "docker-compose.tor.yml",
            "docker-compose.i2p.yml",
            "docker-compose.nginx.yml",
            "docker-compose.local.yml",
        ]
        .map(str::to_owned)
        .to_vec()
    }

    #[test]
    fn no_flag_means_every_overlay() {
        assert_eq!(compose_files(&StopOptions::default()), all());
    }

    #[test]
    fn one_flag_selects_only_its_overlay() {
        let tor = StopOptions {
            tor: true,
            ..StopOptions::default()
        };
        assert_eq!(
            compose_files(&tor),
            vec![
                "docker-compose.yml".to_owned(),
                "docker-compose.tor.yml".to_owned()
            ]
        );
    }

    #[test]
    fn all_is_every_overlay_too() {
        assert_eq!(compose_files(&StopOptions::every_overlay()), all());
    }
}
