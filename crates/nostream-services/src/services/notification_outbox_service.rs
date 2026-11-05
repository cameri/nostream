//! `notification-outbox-service.ts`: claim a batch, dispatch each message, mark it delivered
//! or failed with the merged retry values.

use std::sync::Arc;

use nostream_storage::repositories::NotificationOutboxRepository;

use crate::error::ServicesError;
use crate::services::operator_notification_service::{DispatchContext, NotificationDispatcher};

/// The batch one pass claims (`NOTIFICATION_OUTBOX_BATCH_SIZE`,
/// `src/services/notification-outbox-service.ts:7`).
pub const NOTIFICATION_OUTBOX_BATCH_SIZE: u64 = 20;

/// The default attempt ceiling (`NOTIFICATION_OUTBOX_MAX_ATTEMPTS`, `:8`).
pub const NOTIFICATION_OUTBOX_MAX_ATTEMPTS: i32 = 5;

/// The default backoff base (`:9`).
pub const NOTIFICATION_OUTBOX_BASE_DELAY_MS: i64 = 1_000;

/// `NotificationOutboxService`.
pub struct NotificationOutboxService {
    outbox: Arc<dyn NotificationOutboxRepository>,
    dispatcher: Arc<dyn NotificationDispatcher>,
    max_attempts: i32,
    base_delay_ms: i64,
}

impl NotificationOutboxService {
    /// Builds the walk with the merged retry block.
    pub fn new(
        outbox: Arc<dyn NotificationOutboxRepository>,
        dispatcher: Arc<dyn NotificationDispatcher>,
        max_attempts: i32,
        base_delay_ms: i64,
    ) -> Self {
        Self {
            outbox,
            dispatcher,
            max_attempts,
            base_delay_ms,
        }
    }

    /// `processBatch`: the number of messages delivered.
    pub async fn process_batch(&self, limit: u64) -> Result<u64, ServicesError> {
        let messages = self.outbox.claim_batch(limit).await?;

        if messages.is_empty() {
            return Ok(0);
        }

        let mut delivered = 0u64;

        for message in messages {
            let context = DispatchContext {
                outbox_id: Some(message.id.clone()),
                attempt_number: message.attempt_count + 1,
            };

            match self
                .dispatcher
                .dispatch(&message.event_type, &message.payload, &context)
                .await
            {
                Ok(()) => {
                    self.outbox.mark_delivered(&message.id).await?;
                    delivered += 1;
                }
                Err(error) => {
                    let reason = error.to_string();
                    tracing::error!(
                        outbox_id = message.id,
                        error = %reason,
                        "notification outbox delivery failed"
                    );
                    self.outbox
                        .mark_failed(
                            &message.id,
                            &reason,
                            message.attempt_count + 1,
                            self.max_attempts,
                            self.base_delay_ms,
                        )
                        .await?;
                }
            }
        }

        Ok(delivered)
    }
}
