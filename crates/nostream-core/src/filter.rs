//! Subscription filters. Mirrors `src/@types/subscription.ts` and `src/utils/filter.ts`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::event::{EventId, KindSelector, Pubkey};

/// A subscription id (`src/@types/subscription.ts` `SubscriptionId`).
pub type SubscriptionId = String;

/// A Nostr REQ filter (`src/@types/subscription.ts` `SubscriptionFilter`).
///
/// Single-letter tag filters (`#e`, `#p`, …) are carried in `tags`, keyed without the `#`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Filter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<EventId>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<KindSelector>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authors: Option<Vec<Pubkey>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(flatten)]
    pub tags: BTreeMap<String, Vec<String>>,
}
