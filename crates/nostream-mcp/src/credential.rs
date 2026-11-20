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
//!
//! Both forms are checked the same way before the document is parsed: the target must be a
//! regular file, it must carry **no group or other permission** (`mode & 0o077 == 0`, which a
//! `0600` file satisfies and a read-only `0400` one does too), and it must be no larger than
//! [`MAX_TOKEN_DOCUMENT_BYTES`]. The checks read the metadata of the object the location names,
//! so a `0644` document is refused whichever way it is delivered, and the read itself is bounded
//! too, so a metadata reading the read does not agree with cannot make that read larger (R27).

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::McpError;

/// The one scope beyond reading: the right to call `settings_set` (R28).
pub const SCOPE_WRITE: &str = "write";

/// The scopes a token document may name, as a refusal states them.
pub const ACCEPTED_SCOPES: &[&str] = &[SCOPE_WRITE];

/// The mode a token document is usually written with: owner read and write, and nothing for
/// anyone else. It is the number the refusal names as its example; the rule is [`GROUP_OR_OTHER`]'s
/// — no group or other permission — which a read-only `0400` document satisfies too (R27).
pub const TOKEN_FILE_MODE: u32 = 0o600;

/// The bits a token document must not carry: any group or other permission, write included — a
/// file another user could rewrite is not one this door may trust.
const GROUP_OR_OTHER: u32 = 0o077;

/// The most bytes a token document may hold: it names scopes and carries nothing else, so a file
/// larger than this is a wrong path — a log, a data file — rather than a credential (R27).
///
/// The bound holds twice: `checked` refuses the document from the metadata both forms already
/// read, and [`read_bounded`] stops the read one byte past it. Either alone would leave a path the
/// other misses — a `st_size` of `0` on a procfs file, a document a writer grows between the stat
/// and the read — and the file form re-reads the document on every call, so the read is what has
/// to stay the same amount of work whatever the path answers. Neither form may hang on a path
/// that never ends: the type check refuses a pipe or a device before the read.
pub const MAX_TOKEN_DOCUMENT_BYTES: u64 = 4 * 1024;

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
///
/// A refusal can quote the document, because serde names the value it could not accept
/// (`{"scopes": "…"}` echoes that string). That is the document's own text and not a secret — it
/// carries scope names, never a token, by design — so quoting it tells the operator which value
/// to fix, where suppressing it would leave them with a message about a column.
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
    /// typo nowhere in sight. `location` names the document the way [`TokenDocument::parse`]
    /// does, so every document refusal says which document is being read.
    fn scopes(&self, location: &str) -> Result<Scopes, McpError> {
        let mut scopes = Scopes::read_only();
        for name in &self.scopes {
            if name == SCOPE_WRITE {
                scopes = Scopes::writing();
            } else {
                return Err(McpError::Credential(format!(
                    "the admin token document {location} names an unknown scope {name:?}: the \
                     accepted set is {ACCEPTED_SCOPES:?}, and reading is granted to every token"
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
    /// The descriptor must carry a **regular file**, checked exactly as the file form's target is
    /// — type, mode and size, from the metadata of the object the `/proc` path names — because a
    /// descriptor is a way to deliver the document, not a way around its rules (R27). The text is
    /// then read through that path, which opens the file afresh from its start rather than
    /// continuing from whatever offset the parent left.
    ///
    /// `shortcut: /proc/self/fd/<n> is the readable path to an inherited descriptor and needs no
    /// unsafe — the workspace denies unsafe_code and its one carve-out is the storage crate's
    /// (CLAUDE.md) — upgrade when the daemon has to run where /proc is not mounted, which is the
    /// point at which a raw-fd handle earns its audited unsafe block`
    pub fn from_descriptor(fd: i32) -> Result<Self, McpError> {
        let path = PathBuf::from(format!("/proc/self/fd/{fd}"));
        let location = format!("the admin token document on descriptor {fd}");
        let metadata = std::fs::metadata(&path).map_err(|error| {
            McpError::Credential(format!(
                "--admin-token-fd {fd} could not be read: {error} — pass the token document on an \
                 open descriptor, conventionally 3"
            ))
        })?;
        checked(&metadata, &location)?;
        let file = std::fs::File::open(&path).map_err(|error| unreadable(&location, &error))?;
        let text = read_bounded(file, &location)?;
        let named = format!("on descriptor {fd}");
        let document = TokenDocument::parse(&text, &named)?;
        Ok(Self {
            source: Source::Delivered(document.scopes(&named)?),
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
///
/// The file is opened once and its mode checked on the descriptor it was opened as, rather than by
/// path and then again by path: a `metadata` that answered `0600` and a read that then opened
/// whatever the name pointed at would leave a window between the check and the use. Its type is
/// the one thing checked before that open, because opening a FIFO read-only waits for a writer —
/// a token path that became one would stall the door instead of failing it — and checked again on
/// the descriptor, so a swap to a device or a directory is refused as well. Whoever can write the
/// file's directory can also drop in their own `0600` document, which D19 accepts as the boundary;
/// a FIFO swapped in between the two checks is that same writer stalling one call.
///
/// `shortcut: the type is checked by path before the open, because refusing a FIFO on the
/// descriptor would take `O_NONBLOCK`, which needs `libc` or a hardcoded kernel constant this
/// crate has neither of — upgrade when a stalled call has to be impossible rather than merely
/// inside the boundary, which needs that flag`
///
/// `shortcut: the mode is the only ownership check — the process's own euid is not readable
/// through std without adding libc, and 0600 already decides who may read the file, group and
/// other write bits included — upgrade when a root-run mode has to refuse a file owned by another
/// user, which needs a dependency this crate was not given`
fn read_file(path: &Path) -> Result<Scopes, McpError> {
    let location = format!("the admin token file {}", path.display());
    let named = path.display().to_string();
    // Before the open: a FIFO's open blocks, so the type has to be known first.
    let kind = std::fs::metadata(path).map_err(|error| unreadable(&location, &error))?;
    if !kind.is_file() {
        return Err(not_regular(&location));
    }
    let file = std::fs::File::open(path).map_err(|error| unreadable(&location, &error))?;
    let metadata = file
        .metadata()
        .map_err(|error| unreadable(&location, &error))?;
    checked(&metadata, &location)?;
    let text = read_bounded(file, &location)?;
    TokenDocument::parse(&text, &named)?.scopes(&named)
}

/// The document's text, with the bound applied to the read itself and not only to the metadata.
///
/// [`checked`] refuses the document from a size both forms already hold; this is the half that
/// holds when the two disagree — a procfs file whose `st_size` is `0`, or a document a writer grows
/// between the `stat` and the read. `take` stops one byte past the cap, so the read is bounded
/// whatever the path answers, and a document that outgrew its metadata is refused naming the cap
/// rather than read whole.
fn read_bounded(source: impl Read, location: &str) -> Result<String, McpError> {
    let cap = usize::try_from(MAX_TOKEN_DOCUMENT_BYTES).unwrap_or(usize::MAX);
    let mut text = String::new();
    source
        .take(MAX_TOKEN_DOCUMENT_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|error| unreadable(location, &error))?;
    if text.len() > cap {
        return Err(McpError::Credential(format!(
            "{location} carries more than {MAX_TOKEN_DOCUMENT_BYTES} bytes: a token document is at \
             most that many — it lists scope names and carries nothing else"
        )));
    }
    Ok(text)
}

/// The three checks both forms make, from the metadata already in hand: a regular file, no group
/// or other permission, and a size the document's bound allows (R27).
///
/// The metadata is the one the object the location names answers — the descriptor's own for the
/// file form, and the target the `/proc` link resolves to for the descriptor form — so both forms
/// are judged on the same three facts, and neither read is one a caller can grow or stall, because
/// [`read_bounded`] holds the read to the same size this check refuses on.
fn checked(metadata: &std::fs::Metadata, location: &str) -> Result<(), McpError> {
    if !metadata.is_file() {
        return Err(not_regular(location));
    }
    let mode = metadata.permissions().mode() & 0o777;
    if mode & GROUP_OR_OTHER != 0 {
        return Err(McpError::Credential(format!(
            "{location} is mode {mode:04o}: it must carry no group or other permission \
             ({TOKEN_FILE_MODE:04o} is the usual mode), so no one but its owner can read or \
             rewrite it"
        )));
    }
    let size = metadata.len();
    if size > MAX_TOKEN_DOCUMENT_BYTES {
        return Err(McpError::Credential(format!(
            "{location} is {size} bytes: a token document is at most {MAX_TOKEN_DOCUMENT_BYTES} \
             bytes — it lists scope names and carries nothing else"
        )));
    }
    Ok(())
}

fn not_regular(location: &str) -> McpError {
    McpError::Credential(format!(
        "{location} is not a regular file: the document is read as a file of bytes, so a pipe, a \
         device or a directory there would stall that read, never end it, or give it nothing"
    ))
}

fn unreadable(location: &str, error: &std::io::Error) -> McpError {
    McpError::Credential(format!("{location} could not be read: {error}"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use std::io::Cursor;

    use super::*;

    /// [`checked`] refuses the document from metadata; the read does not trust it. A reader that
    /// answers more than the metadata did — a procfs file whose `st_size` is `0`, a document a
    /// writer grew between the `stat` and the read — is stopped one byte past the cap rather than
    /// read whole (R27), which is what the `take` in [`read_bounded`] is for.
    #[test]
    fn the_read_stops_one_byte_past_the_cap() {
        let cap = usize::try_from(MAX_TOKEN_DOCUMENT_BYTES).unwrap();
        let mut document = Cursor::new(vec![b' '; cap * 2]);
        let refused = read_bounded(&mut document, "the document").expect_err("a read past the cap");
        assert!(
            refused.to_string().contains("more than 4096"),
            "the refusal names the cap: {refused}"
        );
        // Without the `take` the read runs to the end of whatever the path answers, which is how
        // a `st_size` of `0` became a 103 539-byte read.
        assert_eq!(
            document.position(),
            MAX_TOKEN_DOCUMENT_BYTES + 1,
            "the read stopped one byte past the cap"
        );
    }

    /// A document inside the cap is read whole: the bound refuses the wrong path, not the
    /// credential.
    #[test]
    fn a_document_at_the_cap_is_read() {
        let cap = usize::try_from(MAX_TOKEN_DOCUMENT_BYTES).unwrap();
        let document = Cursor::new(vec![b' '; cap]);
        assert_eq!(read_bounded(document, "the document").unwrap().len(), cap);
    }
}
