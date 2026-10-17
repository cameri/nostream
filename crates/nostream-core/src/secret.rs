//! Secrets held in settings. Mirrors `src/utils/secret.ts` / `src/@types/base.ts` `Secret`.

use serde::{Deserialize, Serialize};

/// A hex-encoded secret key.
///
/// `Debug` never prints the value, so a logged settings struct cannot leak it.
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

impl Secret {
    /// The raw value. Callers must not log it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}
