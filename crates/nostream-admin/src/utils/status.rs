//! The relay status document: the daemon publishes it, the MCP door reads it (ADR 0016 D1).
//!
//! It is the one artifact carrying the relay process's own facts — its uptime, its live
//! connection count and its worker rows — to a process that hosts no relay: heartbeats are
//! process memory and `AdminState` holds no `Relay` handle, so a tool answering from its own
//! process would report a running relay as idle. The daemon is its only writer and the MCP
//! door its only reader, which is not ADR 0014 D18's second-writer hazard — that is about
//! `admin-audit.jsonl` and the settings write, and neither is this file.

use std::path::{Path, PathBuf};
use std::time::Duration;

use nostream_config::SettingsPaths;
use serde::{Deserialize, Serialize};

use crate::error::AdminError;
use crate::state::{AdminState, iso8601};
use crate::utils::workers::{self, WorkerRow};

/// The document's name under the config base directory.
pub const STATUS_FILE: &str = "relay-status.json";

/// How often the daemon rewrites the document: six writes inside the freshness bound, so one
/// missed write is still fresh, and 5 s is the coarsest cadence that makes a connection count
/// worth reading.
pub const STATUS_INTERVAL: Duration = Duration::from_millis(5_000);

/// How old a document may be and still be reported: 30 s is fresh, 31 s is not.
pub const STATUS_TTL_SECONDS: u64 = 30;

/// The document's four keys, camelCase like the console's own `uptimeSeconds`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDocument {
    pub generated_at: String,
    pub uptime_seconds: u64,
    pub active_connections: u64,
    pub workers: Vec<WorkerRow>,
}

/// A document fresh enough to report, and how old it was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    pub document: StatusDocument,
    pub age_seconds: u64,
}

/// Why there is no document to report. The reason is the caller's whole message: every one of
/// them names the file, so a reader can tell what to look at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusError {
    pub reason: String,
}

/// The file's path: `<config_base_dir>/relay-status.json`, beside `admin-audit.jsonl`.
pub fn path(paths: &SettingsPaths) -> PathBuf {
    paths.config_base_dir.join(STATUS_FILE)
}

/// Assembles the document from the implementations that already exist and nothing else: the
/// state's own uptime, its clock, and the console's worker rows.
pub fn collect(state: &AdminState, active_connections: u64) -> Result<StatusDocument, AdminError> {
    let settings = state.settings()?;

    Ok(StatusDocument {
        generated_at: iso8601(state.clock().now_ms()),
        uptime_seconds: state.uptime_seconds(),
        active_connections,
        workers: workers::rows(state, &settings),
    })
}

/// Replaces the file atomically: a sibling `.tmp` write then a rename, so a reader never sees
/// a half-written document and no `.tmp` survives a successful write.
pub fn write(path: &Path, document: &StatusDocument) -> std::io::Result<()> {
    let body = serde_json::to_vec(document).map_err(std::io::Error::other)?;
    let staging = staging_path(path);

    std::fs::write(&staging, body)?;
    std::fs::rename(&staging, path)
}

/// Reads the document, at most [`STATUS_TTL_SECONDS`] old. Nothing caches it: the read happens
/// per call, so a rewrite or a deletion is in force by the next one.
pub fn read(paths: &SettingsPaths, now_ms: u64) -> Result<Published, StatusError> {
    let path = path(paths);
    let unreadable = |error: &dyn std::fmt::Display| StatusError {
        reason: format!(
            "the relay status document at {} could not be read: {error}",
            path.display()
        ),
    };

    let raw = std::fs::read_to_string(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            StatusError {
                reason: format!("no relay status document at {}", path.display()),
            }
        } else {
            unreadable(&error)
        }
    })?;

    let document: StatusDocument =
        serde_json::from_str(&raw).map_err(|error| unreadable(&error))?;
    let generated = chrono::DateTime::parse_from_rfc3339(&document.generated_at)
        .map_err(|error| unreadable(&error))?;
    let generated_ms = u64::try_from(generated.timestamp_millis()).unwrap_or(0);
    let age_seconds = now_ms.saturating_sub(generated_ms) / 1000;

    if age_seconds > STATUS_TTL_SECONDS {
        return Err(StatusError {
            reason: format!(
                "the relay status document at {} is {age_seconds} seconds old; the bound is \
                 {STATUS_TTL_SECONDS}",
                path.display()
            ),
        });
    }

    Ok(Published {
        document,
        age_seconds,
    })
}

/// The staging file beside `path`: `<file>.tmp`.
fn staging_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();

    name.push(".tmp");

    PathBuf::from(name)
}
