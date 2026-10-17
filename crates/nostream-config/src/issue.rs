//! Validation findings. Mirrors `src/utils/settings-config.ts` `ValidationIssue`.

use std::fmt;

/// One validation finding: a dot-path into the settings document and the capture's message.
///
/// `Display` renders `{path}: {message}`, which is what `nostreamd --check` and
/// `nostream-cli config validate` print one per line.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Issue {
    /// The dot-path of the offending value (`a.b[0].c`; `$` for the document root).
    pub path: String,
    /// The operator-facing message, byte-identical to the capture's.
    pub message: String,
}

impl Issue {
    /// Builds an issue from anything string-like.
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for Issue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.path, self.message)
    }
}
