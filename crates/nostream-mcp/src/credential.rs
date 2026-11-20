//! The stdio door's own credential: a scoped token document, delivered by file or descriptor.
//!
//! It is neither the console's session token nor an environment variable (R26–R29). A session
//! token belongs to the HTTP gate, whose one shared key and clock-based expiry leave the operator
//! no way to revoke this door on its own; an environment variable is readable at
//! `/proc/<pid>/environ` and inherited by every child process. The document below is a file the
//! operator owns, or a descriptor a parent handed over, and either way it can be taken away
//! without touching anything else.
//!
//! The two forms differ in exactly the property that matters: the **file** is re-read on the path
//! that decides a call, so deleting or rewriting it *is* the revocation, while the **descriptor**
//! is read once at start, so its lifetime is the process's. Nothing here is cached for the file
//! form, deliberately — one small file per call is the price of a revocation that needs no
//! server-side store.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::McpError;

/// The one scope beyond reading: the right to call `settings_set` (R28).
pub const SCOPE_WRITE: &str = "write";

/// The scopes a token document may name, as a refusal states them.
pub const ACCEPTED_SCOPES: &[&str] = &[SCOPE_WRITE];

/// The mode a token file must carry: owner read and write, and nothing for anyone else (R27).
pub const TOKEN_FILE_MODE: u32 = 0o600;

/// The bits a token file must not carry: any group or other permission, write included — a file
/// another user could rewrite is not one this door may trust.
const GROUP_OR_OTHER: u32 = 0o077;

/// The scopes a token document grants.
///
/// Reading is not a scope: every accepted document reads (R28). `write` is the one name a
/// document may add, and it is what makes `settings_set` callable.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Scopes {
    write: bool,
}

impl Scopes {
    /// The grant a document with no `scopes` carries: the three read tools.
    pub fn read_only() -> Self {
        Self::default()
    }

    /// The grant a document naming [`SCOPE_WRITE`] carries.
    pub fn writing() -> Self {
        Self { write: true }
    }

    /// Whether this grant covers `scope`.
    pub fn includes(&self, scope: &str) -> bool {
        scope == SCOPE_WRITE && self.write
    }
}

/// The token document's shape: `{"scopes": ["write"]}`, with `scopes` optional (R27).
///
/// The set is closed. A document carrying any other key — a half-migrated one still holding a
/// session token under `token`, say — is refused rather than read for less than it says.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenDocument {
    #[serde(default)]
    scopes: Vec<String>,
}

impl TokenDocument {
    fn parse(text: &str, location: &str) -> Result<Self, McpError> {
        serde_json::from_str(text).map_err(|error| {
            McpError::Credential(format!(
                "the admin token document {location} is not JSON of the shape \
                 {{\"scopes\": [\"{SCOPE_WRITE}\"]}}: {error}"
            ))
        })
    }

    /// The grant, or the refusal that stops the mode starting (R27).
    ///
    /// An unknown scope is never silently dropped: a document that says `admin` and is read as
    /// "no scopes" would answer `Forbidden` to calls the operator believed it allowed, with the
    /// typo nowhere in sight.
    fn scopes(&self) -> Result<Scopes, McpError> {
        let mut scopes = Scopes::read_only();
        for name in &self.scopes {
            if name == SCOPE_WRITE {
                scopes = Scopes::writing();
            } else {
                return Err(McpError::Credential(format!(
                    "the admin token document names an unknown scope {name:?}: the accepted set \
                     is {ACCEPTED_SCOPES:?}, and reading is granted to every token"
                )));
            }
        }
        Ok(scopes)
    }
}

/// Where the credential is read from: the file, or the document a descriptor carried (R29).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Source {
    /// A file, re-read on every call: rewriting or deleting it is the revocation.
    File(PathBuf),
    /// The document a descriptor carried, read once at start: the process's lifetime is its own.
    Delivered(Scopes),
}

/// The stdio door's credential: the token document and where it is read from (R27).
#[derive(Debug, Clone)]
pub struct Credential {
    source: Source,
}

impl Credential {
    /// A document delivered by file.
    ///
    /// Reads it once here so the mode refuses to start on a file it could not accept (R27); every
    /// call then reads it again, because the file's lifetime is the credential's (R29).
    pub fn from_file(path: impl Into<PathBuf>) -> Result<Self, McpError> {
        let path = path.into();
        read_file(&path)?;
        Ok(Self {
            source: Source::File(path),
        })
    }

    /// The same document on a descriptor the parent passed (`--admin-token-fd`), read once.
    ///
    /// `/proc/self/fd/<n>` is the readable path to a descriptor this process inherited and needs
    /// no `unsafe`: the workspace denies `unsafe_code` and its one carve-out is the storage
    /// crate's (`CLAUDE.md`). It reads a regular file and a pipe alike, from the descriptor's own
    /// offset.
    pub fn from_descriptor(fd: i32) -> Result<Self, McpError> {
        let path = PathBuf::from(format!("/proc/self/fd/{fd}"));
        let text = std::fs::read_to_string(&path).map_err(|error| {
            McpError::Credential(format!(
                "--admin-token-fd {fd} could not be read: {error} — pass the token document on an \
                 open descriptor, conventionally 3"
            ))
        })?;
        let document = TokenDocument::parse(&text, &format!("on descriptor {fd}"))?;
        Ok(Self {
            source: Source::Delivered(document.scopes()?),
        })
    }

    /// The grant the current document carries — the decision point of every call.
    ///
    /// The file form reads the file now, so a rewrite or a deletion has taken effect by the time
    /// this returns (R29).
    pub fn grant(&self) -> Result<Scopes, McpError> {
        match &self.source {
            Source::File(path) => read_file(path),
            Source::Delivered(scopes) => Ok(*scopes),
        }
    }
}

/// One token file, checked and read: the mode's file rule, in one place (R27).
fn read_file(path: &Path) -> Result<Scopes, McpError> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        McpError::Credential(format!(
            "the admin token file {} could not be read: {error}",
            path.display()
        ))
    })?;
    let mode = metadata.permissions().mode() & 0o777;
    if mode & GROUP_OR_OTHER != 0 {
        return Err(McpError::Credential(format!(
            "the admin token file {} is mode {mode:04o}: it must be {TOKEN_FILE_MODE:04o}, \
             readable and writable by its owner alone",
            path.display()
        )));
    }
    let text = std::fs::read_to_string(path).map_err(|error| {
        McpError::Credential(format!(
            "the admin token file {} could not be read: {error}",
            path.display()
        ))
    })?;
    TokenDocument::parse(&text, &path.display().to_string())?.scopes()
}
