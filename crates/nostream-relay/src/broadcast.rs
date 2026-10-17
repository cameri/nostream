//! Cross-worker broadcast fan-out. Mirrors `src/relay-broadcast/redis-relay-broadcast-fanout.ts`
//! and the deduplicator/message/state utils beside it.

use crate::error::RelayError;

/// One relay-broadcast envelope (`src/utils/relay-broadcast-message.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BroadcastMessage {
    pub kind: String,
    pub payload: String,
}

/// Publishes an envelope to the other workers through Redis.
///
/// Phase 1 stub — job 005; will publish through the Redis fan-out channel; see `src/relay-broadcast/redis-relay-broadcast-fanout.ts`.
pub async fn publish(_message: &BroadcastMessage) -> Result<(), RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::broadcast::publish",
    })
}

/// Drops an envelope already seen by this worker.
///
/// Phase 1 stub — job 005; will deduplicate by message id; see `src/utils/relay-broadcast-deduplicator.ts`.
pub fn deduplicate(_message: &BroadcastMessage) -> Result<bool, RelayError> {
    Err(RelayError::NotImplemented {
        module: "relay::broadcast::deduplicate",
    })
}
