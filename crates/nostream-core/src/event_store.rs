//! The event-store backend set. Mirrors `src/constants/base.ts` `EventStoreBackend` and
//! `src/utils/event-store.ts` `EVENT_STORE_BACKENDS`.
//!
//! The capture's enum has one member (`POSTGRES`). The rewrite adds `LMDB`, which is the
//! backend this rewrite exists to provide; the config validator uses this list as the set
//! of acceptable `eventStore.backend` values (spec D7).

use serde::{Deserialize, Serialize};

/// The storage backend selected at startup (`src/constants/base.ts` `EventStoreBackend`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventStoreBackend {
    Postgres,
    Lmdb,
}

impl EventStoreBackend {
    /// Every member, in the order the validator renders them.
    pub const ALL: [Self; 2] = [Self::Postgres, Self::Lmdb];

    /// The wire/settings spelling of this backend.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Postgres => "postgres",
            Self::Lmdb => "lmdb",
        }
    }

    /// Parses a settings value. A non-string or unknown value is `None`.
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|backend| backend.as_str() == value)
    }
}

impl std::fmt::Display for EventStoreBackend {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}
