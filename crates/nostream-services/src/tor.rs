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
            private_key: private_key.or_else(|| Some(key.to_owned())),
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
pub async fn ensure_hidden_service(config: &TorConfig) -> HiddenServiceOutcome {
    let Some(host) = config.host.as_deref() else {
        return HiddenServiceOutcome::Disabled;
    };

    if host.is_empty() {
        return HiddenServiceOutcome::Disabled;
    }

    let key_file = config.key_file();
    let stored_key = tokio::fs::read_to_string(&key_file)
        .await
        .ok()
        .filter(|key| !key.is_empty());

    let mut client = match TorClient::connect(host, config.port, &config.password).await {
        Ok(client) => client,
        Err(error) => {
            tracing::debug!(error = %error, "Tor hidden service disabled");
            return HiddenServiceOutcome::Disabled;
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
            return HiddenServiceOutcome::Disabled;
        }
    };

    if stored_key.is_none()
        && let Some(private_key) = onion.private_key.as_deref()
        && let Err(error) = tokio::fs::write(&key_file, private_key).await
    {
        tracing::warn!(path = %key_file.display(), error = %error, "unable to save the onion key");
    }

    let service_id = onion.service_id;
    client.quit().await;

    HiddenServiceOutcome::Enabled {
        service_id,
        port: config.hidden_port,
    }
}
