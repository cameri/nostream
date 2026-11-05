//! The Tor control-port client and the hidden-service bootstrap. Mirrors `src/tor/client.ts`
//! and the `addOnion` call in `src/app/app.ts:217-225`.

use std::path::{Path, PathBuf};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::error::ServicesError;

/// The control port when `TOR_CONTROL_PORT` is unset (`src/tor/client.ts:18`).
pub const DEFAULT_CONTROL_PORT: u16 = 9_051;

/// The hidden-service port when `HIDDEN_SERVICE_PORT` is unset (`src/app/app.ts:108`).
pub const DEFAULT_HIDDEN_SERVICE_PORT: u16 = 80;

/// The key file under the configuration directory (`src/tor/client.ts:12`).
pub const ONION_KEY_FILE: &str = "v3_onion_private_key";

/// Where a new key is staged before it replaces the key file. A write that is cancelled leaves
/// this file behind, never a truncated key at [`ONION_KEY_FILE`].
const ONION_KEY_TEMP_FILE: &str = "v3_onion_private_key.tmp";

/// How long the shutdown waits for `QUIT`'s reply: the control port may be gone, and the
/// daemon must not be held open by it.
pub const QUIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// The bootstrap's configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TorConfig {
    pub host: Option<String>,
    pub port: u16,
    pub password: String,
    pub hidden_port: u16,
    pub config_dir: PathBuf,
    pub relay_port: u16,
}

impl TorConfig {
    /// The configuration the process environment describes.
    pub fn from_env(config_dir: &Path, relay_port: u16) -> Self {
        Self {
            host: std::env::var("TOR_HOST")
                .ok()
                .filter(|host| !host.is_empty()),
            port: std::env::var("TOR_CONTROL_PORT")
                .ok()
                .and_then(|port| port.parse().ok())
                .unwrap_or(DEFAULT_CONTROL_PORT),
            password: std::env::var("TOR_PASSWORD").unwrap_or_default(),
            hidden_port: std::env::var("HIDDEN_SERVICE_PORT")
                .ok()
                .and_then(|port| port.parse().ok())
                .unwrap_or(DEFAULT_HIDDEN_SERVICE_PORT),
            config_dir: config_dir.to_path_buf(),
            relay_port,
        }
    }

    /// The key file's path.
    pub fn key_file(&self) -> PathBuf {
        self.config_dir.join(ONION_KEY_FILE)
    }

    /// `Port=<hidden>,127.0.0.1:<relay port>` (V33, ADR 0010).
    pub fn port_spec(&self) -> String {
        format!("{},127.0.0.1:{}", self.hidden_port, self.relay_port)
    }
}

/// One `ADD_ONION` result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnionService {
    /// The service id with `.onion` appended.
    pub service_id: String,
    /// The private key the reply carried, or the key the request named.
    pub private_key: Option<String>,
}

/// What the bootstrap settled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HiddenServiceOutcome {
    Enabled { service_id: String, port: u16 },
    Disabled,
}

/// The bootstrap's result and the control connection that keeps the onion alive.
///
/// Tor removes a service created without `Flags=Detach` when its control connection closes,
/// so the connection is part of the result: while this value is alive the service is up, and
/// [`HiddenServiceBootstrap::shutdown`] is what ends it. Dropping the value without shutting it
/// down ends the service too, which is never what a caller means, so the type is `#[must_use]`
/// and the drop is logged.
#[must_use = "the control connection keeps the onion up; hold it and call `shutdown` at exit"]
pub struct HiddenServiceBootstrap {
    outcome: HiddenServiceOutcome,
    client: Option<TorClient>,
}

impl HiddenServiceBootstrap {
    /// What the bootstrap settled.
    pub fn outcome(&self) -> &HiddenServiceOutcome {
        &self.outcome
    }

    /// `QUIT`s the control connection, best effort and bounded: Tor drops the service when the
    /// connection closes, and a control port that stops answering must not hold the drain open.
    ///
    /// The client is taken out of the field first, so the [`Drop`] below stays silent for an
    /// orderly exit.
    pub async fn shutdown(mut self) {
        if let Some(mut client) = self.client.take() {
            let _ = tokio::time::timeout(QUIT_TIMEOUT, client.quit()).await;
        }
    }
}

impl Drop for HiddenServiceBootstrap {
    fn drop(&mut self) {
        if self.client.is_some() {
            tracing::warn!(
                "the Tor control connection was dropped without `shutdown`; the hidden service \
                 went down with it"
            );
        }
    }
}

/// A connection to the control port, with the reply buffer between commands.
pub struct TorClient {
    stream: TcpStream,
    buffer: String,
}

impl TorClient {
    /// Connects and authenticates (`createTorClient` + `connect`,
    /// `src/tor/client.ts:33-56`).
    pub async fn connect(host: &str, port: u16, password: &str) -> Result<Self, ServicesError> {
        let stream = TcpStream::connect((host, port)).await.map_err(|error| {
            ServicesError::Tor(format!("Tor control port connect failed: {error}"))
        })?;
        let mut client = Self {
            stream,
            buffer: String::new(),
        };

        let reply = client
            .send_command(&format!("AUTHENTICATE \"{password}\""))
            .await?;

        if !reply.starts_with("250") {
            return Err(ServicesError::Tor(format!(
                "Tor auth failed: {}",
                reply.trim_end_matches("\r\n")
            )));
        }

        Ok(client)
    }

    /// `ADD_ONION <key> Port=<spec>` (`addOnion`, `src/tor/client.ts:121-142`).
    pub async fn add_onion(
        &mut self,
        port_spec: &str,
        key: Option<&str>,
    ) -> Result<OnionService, ServicesError> {
        let request_key = key;
        let key = key.unwrap_or("NEW:BEST");
        let reply = self
            .send_command(&format!("ADD_ONION {key} Port={port_spec}"))
            .await?;

        if !reply.starts_with("250") {
            return Err(ServicesError::Tor(
                reply.trim_end_matches("\r\n").to_owned(),
            ));
        }

        let mut service_id = None;
        let mut private_key = None;

        for line in reply.split("\r\n") {
            let Some((code, separator)) = reply_line(line) else {
                continue;
            };

            if code != "250" || separator == '+' {
                continue;
            }

            if let Some((name, value)) = line[4..].split_once('=') {
                match name {
                    "ServiceID" => service_id = Some(value.to_owned()),
                    "PrivateKey" => private_key = Some(value.to_owned()),
                    _ => {}
                }
            }
        }

        let service_id = service_id.ok_or_else(|| {
            ServicesError::Tor(format!("Tor reply has no ServiceID: {}", reply.trim()))
        })?;

        Ok(OnionService {
            service_id: format!("{service_id}.onion"),
            // `if (!result.PrivateKey && privateKey)` (`src/tor/client.ts:142-143`): the key
            // the request named is reported back, never the `NEW:BEST` default.
            private_key: private_key.or_else(|| request_key.map(str::to_owned)),
        })
    }

    /// `QUIT`, best effort (`src/tor/client.ts:144-147`).
    pub async fn quit(&mut self) {
        let _ = self.send_command("QUIT").await;
        let _ = self.stream.shutdown().await;
    }

    async fn send_command(&mut self, command: &str) -> Result<String, ServicesError> {
        self.stream
            .write_all(format!("{command}\r\n").as_bytes())
            .await
            .map_err(|error| ServicesError::Tor(format!("Tor control write failed: {error}")))?;
        self.stream
            .flush()
            .await
            .map_err(|error| ServicesError::Tor(format!("Tor control write failed: {error}")))?;

        loop {
            if is_complete_reply(&self.buffer) {
                return Ok(std::mem::take(&mut self.buffer));
            }

            let mut chunk = [0u8; 4 * 1024];
            let read =
                self.stream.read(&mut chunk).await.map_err(|error| {
                    ServicesError::Tor(format!("Tor control read failed: {error}"))
                })?;

            if read == 0 {
                return Err(ServicesError::Tor(format!(
                    "Tor control port closed with an incomplete reply: {}",
                    self.buffer.trim()
                )));
            }

            self.buffer
                .push_str(&String::from_utf8_lossy(&chunk[..read]));
        }
    }
}

/// `isCompleteTorReply` (`src/tor/client.ts:58-105`).
fn is_complete_reply(buffer: &str) -> bool {
    if !buffer.ends_with("\r\n") {
        return false;
    }

    let mut lines: Vec<&str> = buffer.split("\r\n").collect();

    if lines.last() == Some(&"") {
        lines.pop();
    }

    let Some(first) = lines.first() else {
        return false;
    };
    let Some((status, _)) = reply_line(first) else {
        return false;
    };

    let mut in_data_block = false;
    let last = lines.len().saturating_sub(1);

    for (index, line) in lines.iter().enumerate() {
        if in_data_block {
            if *line == "." {
                in_data_block = false;
            }

            continue;
        }

        let Some((code, separator)) = reply_line(line) else {
            return false;
        };

        if code != status {
            return false;
        }

        if separator == ' ' {
            return index == last;
        }

        if separator == '+' {
            in_data_block = true;
        }
    }

    false
}

/// `^(\d{3})([\s\-+])` on one reply line.
fn reply_line(line: &str) -> Option<(&str, char)> {
    let bytes = line.as_bytes();

    if bytes.len() < 4 || !bytes[..3].iter().all(u8::is_ascii_digit) {
        return None;
    }

    let separator = char::from(bytes[3]);

    if !matches!(separator, ' ' | '-' | '+') {
        return None;
    }

    Some((&line[..3], separator))
}

/// The startup's one bootstrap attempt. A missing host, an unreachable control port and a
/// refused `ADD_ONION` all answer [`HiddenServiceOutcome::Disabled`]; the capture never fails
/// startup on Tor (`src/app/app.ts:204-212`).
///
/// The returned [`HiddenServiceBootstrap`] owns the control connection. `ADD_ONION` carries no
/// `Flags=Detach`, so Tor removes the service as soon as that connection closes: an
/// `Enabled` outcome whose value has been dropped is an onion nobody can reach.
pub async fn ensure_hidden_service(config: &TorConfig) -> HiddenServiceBootstrap {
    let Some(host) = config.host.as_deref() else {
        return HiddenServiceBootstrap::disabled();
    };

    if host.is_empty() {
        return HiddenServiceBootstrap::disabled();
    }

    let key_file = config.key_file();
    let stored_key = tokio::fs::read_to_string(&key_file)
        .await
        .ok()
        .filter(|key| !key.is_empty());

    // An adopted key was written by whoever installed first: the capture leaves it 0644 under
    // the usual umask, and this daemon would otherwise keep that mode for the life of the
    // installation. Narrowing happens on the read path because an existing key is never
    // rewritten.
    if stored_key.is_some()
        && let Err(error) = narrow_key_permissions(&key_file).await
    {
        tracing::warn!(
            path = %key_file.display(),
            error = %error,
            "unable to narrow the onion key's permissions"
        );
    }

    let mut client = match TorClient::connect(host, config.port, &config.password).await {
        Ok(client) => client,
        Err(error) => {
            tracing::debug!(error = %error, "Tor hidden service disabled");
            return HiddenServiceBootstrap::disabled();
        }
    };

    let onion = match client
        .add_onion(&config.port_spec(), stored_key.as_deref())
        .await
    {
        Ok(onion) => onion,
        Err(error) => {
            tracing::debug!(error = %error, "Tor hidden service disabled");
            client.quit().await;
            return HiddenServiceBootstrap::disabled();
        }
    };

    // `addOnion` throws when no key arrived (`src/tor/client.ts:197-207`), so the service is
    // reported disabled rather than left unpinned.
    let Some(private_key) = onion.private_key.as_deref() else {
        tracing::debug!(
            service_id = %onion.service_id,
            "Tor replied without a private key; the hidden service is disabled"
        );
        client.quit().await;
        return HiddenServiceBootstrap::disabled();
    };

    if stored_key.is_none()
        && let Err(error) = write_private_key(&key_file, private_key).await
    {
        tracing::warn!(path = %key_file.display(), error = %error, "unable to save the onion key");
    }

    HiddenServiceBootstrap {
        outcome: HiddenServiceOutcome::Enabled {
            service_id: onion.service_id,
            port: config.hidden_port,
        },
        client: Some(client),
    }
}

impl HiddenServiceBootstrap {
    /// A bootstrap that holds no service.
    fn disabled() -> Self {
        Self {
            outcome: HiddenServiceOutcome::Disabled,
            client: None,
        }
    }
}

/// Sets the owner-only mode on an onion key that already exists. A key this daemon writes is
/// governed by [`write_private_key`]; an adopted one is not, and is only ever read.
#[cfg(unix)]
async fn narrow_key_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await
}

#[cfg(not(unix))]
async fn narrow_key_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Writes the onion key with owner-only permissions: it is the one long-lived secret the
/// daemon writes to disk, and the process umask would otherwise leave it world-readable.
///
/// The key is staged next to its destination and renamed into place, so a write cancelled
/// between the two steps leaves the temp file behind rather than a truncated key file that
/// the next boot would read as a stored key. The staging file is created 0600 and its mode is
/// set on the handle as well, because `mode` applies only at creation.
async fn write_private_key(path: &Path, key: &str) -> std::io::Result<()> {
    let temporary = path.with_file_name(ONION_KEY_TEMP_FILE);
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);

    #[cfg(unix)]
    options.mode(0o600);

    let mut file = options.open(&temporary).await?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .await?;
    }

    file.write_all(key.as_bytes()).await?;
    file.flush().await?;
    file.sync_all().await?;
    drop(file);

    tokio::fs::rename(&temporary, path).await
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{ONION_KEY_FILE, ONION_KEY_TEMP_FILE, write_private_key};

    #[tokio::test]
    async fn the_key_is_staged_and_renamed_without_leaving_the_temp_file() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join(ONION_KEY_FILE);

        write_private_key(&path, "ED25519-V3:secret")
            .await
            .expect("write");

        assert_eq!(
            std::fs::read_to_string(&path).expect("the key file"),
            "ED25519-V3:secret"
        );
        assert!(
            !directory.path().join(ONION_KEY_TEMP_FILE).exists(),
            "the staged copy is renamed into place"
        );
    }

    /// A key the TypeScript daemon wrote at this path keeps its 0644 through the rename unless
    /// the permission is set on the open handle, which `mode` alone does not do.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_existing_world_readable_key_is_narrowed_to_its_owner() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join(ONION_KEY_FILE);
        std::fs::write(&path, "ED25519-V3:old").expect("write");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");

        write_private_key(&path, "ED25519-V3:new")
            .await
            .expect("write");

        let mode = std::fs::metadata(&path)
            .expect("the key file's metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the key is readable only by its owner");
    }

    /// A write that fails after staging must never land a short key at the path the next boot
    /// reads. The destination is a directory here, so the rename is what fails: the staged key
    /// stays where it is and the key path still holds no key.
    #[tokio::test]
    async fn a_failed_rename_leaves_no_key_at_the_key_path() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join(ONION_KEY_FILE);
        std::fs::create_dir(&path).expect("the key path is a directory");

        let error = write_private_key(&path, "ED25519-V3:secret")
            .await
            .expect_err("renaming a file over a directory fails");
        assert_eq!(error.kind(), std::io::ErrorKind::IsADirectory);

        assert!(
            std::fs::read_to_string(&path).is_err(),
            "no key was written at the key path"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join(ONION_KEY_TEMP_FILE))
                .expect("the staged copy survives"),
            "ED25519-V3:secret",
            "the staged copy is complete; a later write replaces it"
        );
    }

    /// A directory that does not exist fails before anything is staged.
    #[tokio::test]
    async fn a_write_into_a_missing_directory_fails() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("absent").join(ONION_KEY_FILE);

        assert!(write_private_key(&path, "ED25519-V3:secret").await.is_err());
        assert!(!path.exists());
    }
}
