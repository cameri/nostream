//! `start.ts`: start the Docker Compose stack.
//!
//! The order is the capture's (`runStart`, `src/cli/commands/start.ts:71-141`): the root check,
//! the port check, the config bootstrap, the overlay for each flag, the nginx bootstrap, the
//! port-override file, then `docker compose … up --build --remove-orphans [-d] …`. The override
//! file is removed in every outcome, including a failure.

use crate::app::Context;
use crate::bootstrap::{
    ensure_config_bootstrap, ensure_i2p_data_dir, ensure_not_root, ensure_tor_data_dir,
};
use crate::compose::{create_port_override, nginx_configuration, run_compose};
use crate::config::CommandOutput;
use crate::error::CliError;

/// The port the capture refuses outside `1..=65535`, with its one message.
pub const PORT_MESSAGE: &str = "Port must be a safe integer between 1 and 65535";

/// The `DEBUG` default `--debug` sets when the operator has not chosen one.
const DEFAULT_DEBUG: &str = "primary:*,worker:*,knex:*";

/// The parsed `start` flags.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StartOptions {
    pub tor: bool,
    pub i2p: bool,
    pub nginx: bool,
    pub debug: bool,
    pub detach: bool,
    /// The raw `--port` value, validated here rather than by the argument parser: the capture
    /// accepts `--port abc` and refuses it with its own message at exit 1.
    pub port: Option<String>,
}

/// Runs `start` on a runtime the command owns.
pub fn run(
    context: &Context,
    options: &StartOptions,
    passthrough: &[String],
) -> Result<CommandOutput, CliError> {
    context.block_on(start(context, options, passthrough))
}

/// `runStart`.
pub(crate) async fn start(
    context: &Context,
    options: &StartOptions,
    passthrough: &[String],
) -> Result<CommandOutput, CliError> {
    ensure_not_root().await?;

    let port = match &options.port {
        Some(raw) => Some(parse_port(raw)?),
        None => None,
    };

    ensure_config_bootstrap(&context.cwd)?;

    let mut files: Vec<String> = vec!["docker-compose.yml".to_owned()];

    if options.tor {
        ensure_tor_data_dir(&context.cwd)?;
        files.push("docker-compose.tor.yml".to_owned());
    }

    if options.i2p {
        ensure_i2p_data_dir(&context.cwd)?;
        files.push("docker-compose.i2p.yml".to_owned());
    }

    if options.nginx {
        let domain = nginx_configuration(&context.env)?;
        crate::compose::ensure_nginx_bootstrap(&context.cwd, &domain).await?;
        files.push("docker-compose.nginx.yml".to_owned());
    }

    let override_file = match port {
        Some(port) => {
            let file = create_port_override(port)?;
            files.push(file.display().to_string());
            Some(file)
        }
        None => None,
    };

    let mut environment: Vec<(&str, String)> = Vec::new();
    if options.debug {
        environment.push((
            "DEBUG",
            context
                .env
                .get("DEBUG")
                .unwrap_or_else(|| DEFAULT_DEBUG.to_owned()),
        ));
    }

    let mut up: Vec<String> = vec![
        "up".to_owned(),
        "--build".to_owned(),
        "--remove-orphans".to_owned(),
    ];
    if options.detach {
        up.push("-d".to_owned());
    }
    up.extend(
        passthrough
            .iter()
            .filter(|argument| argument.as_str() != "--")
            .cloned(),
    );

    let named: Vec<&str> = files.iter().map(String::as_str).collect();
    let outcome = run_compose(&context.cwd, &named, &up, &environment).await;

    if let Some(file) = override_file
        && file.exists()
    {
        let _ = std::fs::remove_file(&file);
    }

    let code = outcome?;
    Ok(CommandOutput::with_code(
        Vec::new(),
        u8::try_from(code).unwrap_or(1),
    ))
}

/// The capture's port check: a safe integer in `1..=65535`, one message for every refusal.
pub fn parse_port(raw: &str) -> Result<u16, CliError> {
    let trimmed = raw.trim();
    let digits = trimmed.strip_prefix('+').unwrap_or(trimmed);

    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CliError::command(PORT_MESSAGE));
    }

    match trimmed.parse::<u16>() {
        Ok(port) if port >= 1 => Ok(port),
        _ => Err(CliError::command(PORT_MESSAGE)),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn the_port_range_and_its_one_message() {
        assert_eq!(parse_port("9999").unwrap(), 9999);
        for bad in ["0", "70000", "abc", "", "-1", "12.5"] {
            let error = parse_port(bad).unwrap_err();
            assert_eq!(error.to_string(), PORT_MESSAGE, "`{bad}` is refused");
        }
    }
}
