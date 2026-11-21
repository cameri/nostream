//! The Docker Compose argv, the port-override file and the nginx bootstrap: the half of `start`
//! and `stop` that builds a command line rather than running one.
//!
//! Mirrors `src/cli/utils/docker.ts` and `ensureNginxBootstrap`
//! (`src/cli/commands/start.ts:15-69`). A compose file is named only when it exists in the
//! working directory, which is what lets a checkout without the overlays still start.

use std::path::{Path, PathBuf};

use nostream_services::process::{CapturedResult, SpawnFailure};

use crate::bootstrap::project_path;
use crate::error::CliError;

/// One compose invocation's files, in the order the flags named them.
pub fn compose_args(cwd: &Path, files: &[&str], args: &[String]) -> Vec<String> {
    let mut out = vec!["compose".to_owned()];

    for file in files {
        let path = project_path(cwd, &[file]);
        if path.exists() {
            out.push("-f".to_owned());
            out.push(path.display().to_string());
        }
    }

    out.extend(args.iter().cloned());
    out
}

/// `runDockerCompose`: `docker compose -f … args`, with the child's stdio inherited.
pub async fn run_compose(
    cwd: &Path,
    files: &[&str],
    args: &[String],
    env: &[(&str, String)],
) -> Result<i32, CliError> {
    let mut argv = vec!["docker".to_owned()];
    argv.extend(compose_args(cwd, files, args));

    nostream_services::process::run(&argv, env)
        .await
        .map_err(|failure| CliError::command(failure.to_string()))
}

/// `createPortOverrideComposeFile`: a temporary compose file that rebinds the relay's port.
///
/// The name carries the process id and the millisecond clock, exactly as the capture's does, so
/// two starts in one second cannot share a file.
pub fn create_port_override(port: u16) -> Result<PathBuf, CliError> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let file = std::env::temp_dir().join(format!(
        "nostream-port-override-{}-{millis}.yml",
        std::process::id()
    ));

    let content = [
        "services:".to_owned(),
        "  nostream:".to_owned(),
        "    environment:".to_owned(),
        format!("      RELAY_PORT: {port}"),
        "    ports:".to_owned(),
        format!("      - 127.0.0.1:{port}:{port}"),
    ]
    .join("\n");

    std::fs::write(&file, content).map_err(|error| {
        CliError::command(format!("unable to write {}: {error}", file.display()))
    })?;

    Ok(file)
}

/// `ensureNginxBootstrap`: render the nginx site from its template and, when the certificates are
/// missing, mint a self-signed pair with `openssl`.
pub async fn ensure_nginx_bootstrap(cwd: &Path, relay_domain: &str) -> Result<(), CliError> {
    let conf_dir = project_path(cwd, &["nginx", "conf.d"]);
    let template = conf_dir.join("nostream.conf.template");
    let rendered = conf_dir.join("nostream.conf");

    let content = std::fs::read_to_string(&template).map_err(|error| {
        CliError::command(format!("unable to read {}: {error}", template.display()))
    })?;
    std::fs::write(&rendered, content.replace("${RELAY_DOMAIN}", relay_domain)).map_err(
        |error| CliError::command(format!("unable to write {}: {error}", rendered.display())),
    )?;

    let ssl_dir = project_path(cwd, &["nginx", "ssl", "live", relay_domain]);
    let fullchain = ssl_dir.join("fullchain.pem");
    let privkey = ssl_dir.join("privkey.pem");

    if fullchain.exists() && privkey.exists() {
        return Ok(());
    }

    std::fs::create_dir_all(&ssl_dir).map_err(|error| {
        CliError::command(format!("unable to create {}: {error}", ssl_dir.display()))
    })?;

    let argv: Vec<String> = [
        "openssl".to_owned(),
        "req".to_owned(),
        "-x509".to_owned(),
        "-nodes".to_owned(),
        "-newkey".to_owned(),
        "rsa:2048".to_owned(),
        "-days".to_owned(),
        "1".to_owned(),
        "-keyout".to_owned(),
        privkey.display().to_string(),
        "-out".to_owned(),
        fullchain.display().to_string(),
        "-subj".to_owned(),
        format!("/CN={relay_domain}"),
    ]
    .to_vec();

    let code = nostream_services::process::run(&argv, &[])
        .await
        .map_err(|failure: SpawnFailure| CliError::command(failure.to_string()))?;

    if code != 0 {
        return Err(CliError::command(
            "Failed to generate self-signed SSL certificate. Ensure openssl is installed and retry.",
        ));
    }

    Ok(())
}

/// The `RELAY_DOMAIN`/`CERTBOT_EMAIL` checks `--nginx` runs before it renders anything.
pub fn nginx_configuration(env: &crate::env_file::Environment) -> Result<String, CliError> {
    let Some(domain) = env.get("RELAY_DOMAIN").map(|value| value.trim().to_owned()) else {
        return Err(CliError::command(
            "RELAY_DOMAIN environment variable is required when using --nginx (example: \
             RELAY_DOMAIN=relay.example.com).",
        ));
    };

    if domain.is_empty() {
        return Err(CliError::command(
            "RELAY_DOMAIN environment variable is required when using --nginx (example: \
             RELAY_DOMAIN=relay.example.com).",
        ));
    }

    if !is_fqdn(&domain) {
        return Err(CliError::command(
            "RELAY_DOMAIN must be a valid fully-qualified domain name when using --nginx.",
        ));
    }

    match env
        .get("CERTBOT_EMAIL")
        .map(|value| value.trim().to_owned())
    {
        Some(email) if !email.is_empty() => Ok(domain),
        _ => Err(CliError::command(
            "CERTBOT_EMAIL environment variable is required when using --nginx (example: \
             CERTBOT_EMAIL=you@example.com).",
        )),
    }
}

/// The capture's `FQDN_REGEX` (`src/cli/commands/start.ts:12-13`): dot-separated labels, each
/// starting and ending alphanumeric, at most 63 characters.
pub fn is_fqdn(value: &str) -> bool {
    let labels: Vec<&str> = value.split('.').collect();
    if labels.len() < 2 {
        return false;
    }

    labels.iter().all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && label
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            && label
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_alphanumeric)
    })
}

/// The capture's `runCommandWithOutput` answer for a docker probe, as the two `info` paths read
/// it: stdout when the child exited 0, and nothing otherwise.
pub fn captured_stdout(result: &CapturedResult) -> Option<String> {
    match result {
        CapturedResult::Exited {
            code: 0, stdout, ..
        } => Some(stdout.trim().to_owned()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn an_fqdn_needs_two_labels() {
        assert!(is_fqdn("relay.example.com"));
        assert!(is_fqdn("r-1.example"));
        assert!(!is_fqdn("localhost"));
        assert!(!is_fqdn("-bad.example"));
        assert!(!is_fqdn("bad-.example"));
        assert!(!is_fqdn("example..com"));
        assert!(!is_fqdn(""));
    }

    #[test]
    fn only_existing_compose_files_are_named() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        std::fs::write(
            directory.path().join("docker-compose.yml"),
            "services: {}\n",
        )
        .expect("the base file");

        let args = compose_args(
            directory.path(),
            &["docker-compose.yml", "docker-compose.tor.yml"],
            &["down".to_owned()],
        );

        assert_eq!(args[0], "compose");
        assert!(args.contains(&"-f".to_owned()));
        assert!(
            args.iter()
                .any(|argument| argument.ends_with("docker-compose.yml"))
        );
        assert!(
            !args
                .iter()
                .any(|argument| argument.ends_with("docker-compose.tor.yml")),
            "a missing overlay is not named"
        );
        assert_eq!(args.last().map(String::as_str), Some("down"));
    }

    #[test]
    fn the_port_override_carries_the_captures_body() {
        let file = create_port_override(9999).expect("the override writes");
        let content = std::fs::read_to_string(&file).expect("the override reads");
        assert_eq!(
            content,
            "services:\n  nostream:\n    environment:\n      RELAY_PORT: 9999\n    ports:\n      - \
             127.0.0.1:9999:9999"
        );
        assert!(
            file.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(
                    |name| name.starts_with("nostream-port-override-") && name.ends_with(".yml")
                )
        );
        std::fs::remove_file(&file).expect("the override is removed");
    }
}
