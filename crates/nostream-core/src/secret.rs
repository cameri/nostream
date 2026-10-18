//! Secrets held in settings. Mirrors `src/utils/secret.ts` / `src/@types/base.ts` `Secret`.

use serde::{Deserialize, Serialize};

/// A value that must not reach a log or an error message.
///
/// `Debug` and `Display` redact, so a field typed `Secret` cannot leak through a `{:?}` or
/// `{}` of the settings struct that carries it. The guarantee is per-field: a field left a
/// plain `String` prints in the clear, and the document-level `redact_settings_secrets`
/// helper in `nostream-config` covers the document surface instead.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(pub String);

impl std::fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.0.is_empty() {
            formatter.write_str("Secret(\"\")")
        } else {
            formatter.write_str("Secret(***)")
        }
    }
}

impl std::fmt::Display for Secret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("***")
    }
}

impl Secret {
    /// The raw value. Callers must not log it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}
