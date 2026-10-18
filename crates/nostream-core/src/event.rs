//! Shared domain primitives. Mirrors `src/@types/event.ts`, `src/@types/base.ts`,
//! `src/@types/subscription.ts` and `src/constants/base.ts` at the capture commit.

use serde::{Deserialize, Serialize};

/// A 32-byte event id, hex encoded (`src/@types/base.ts` `EventId`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EventId(pub String);

/// A 32-byte public key, hex encoded (`src/@types/base.ts` `Pubkey`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Pubkey(pub String);

/// A Nostr event kind (`src/constants/base.ts` `EventKinds`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Kind(pub u64);

impl Kind {
    pub const METADATA: Self = Self(0);
    pub const CONTACT_LIST: Self = Self(3);
    pub const DELETION: Self = Self(5);
    pub const REPORT: Self = Self(1984);
    pub const EPHEMERAL_START: Self = Self(20_000);
    pub const EPHEMERAL_END: Self = Self(29_999);
    pub const PARAMETERIZED_REPLACEABLE_START: Self = Self(30_000);
    pub const PARAMETERIZED_REPLACEABLE_END: Self = Self(39_999);
}

impl std::fmt::Display for Kind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

/// One kind or an inclusive `[first, last]` range (`src/@types/settings.ts` `EventKindsRange`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum KindSelector {
    Range([Kind; 2]),
    Single(Kind),
}

/// A tag: the wire shape is a positional string array.
pub type Tag = Vec<String>;

/// A Nostr event (`src/@types/event.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub id: EventId,
    pub pubkey: Pubkey,
    pub created_at: i64,
    pub kind: Kind,
    pub tags: Vec<Tag>,
    pub content: String,
    pub sig: String,
}
