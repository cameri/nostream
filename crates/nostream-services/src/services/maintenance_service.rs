//! `maintenance-service.ts`: the retention purge.

use std::sync::Arc;

use nostream_config::Settings;
use nostream_storage::repositories::{EventRepository, EventRetentionOptions};

use crate::error::ServicesError;

/// `MaintenanceService`.
pub struct MaintenanceService {
    events: Arc<dyn EventRepository>,
    settings: Arc<Settings>,
}

impl MaintenanceService {
    /// Builds the purge over the event store.
    pub fn new(events: Arc<dyn EventRepository>, settings: Arc<Settings>) -> Self {
        Self { events, settings }
    }

    /// `clearOldEvents`: one retention call, or none when `maxDays` is absent or `<= 0`.
    pub async fn clear_old_events(&self) -> Result<(), ServicesError> {
        let retention = self
            .settings
            .limits
            .as_ref()
            .and_then(|limits| limits.event.as_ref())
            .and_then(|event| event.retention.as_ref());
        let Some(max_days) = retention
            .and_then(|retention| retention.max_days)
            .filter(|max_days| *max_days > 0)
        else {
            return Ok(());
        };

        let options = EventRetentionOptions {
            max_days: Some(max_days),
            kind_whitelist: retention
                .and_then(|retention| retention.kind.as_ref())
                .and_then(|kind| kind.whitelist.clone()),
            pubkey_whitelist: retention
                .and_then(|retention| retention.pubkey.as_ref())
                .and_then(|pubkey| pubkey.whitelist.clone()),
        };

        let counts = self.events.delete_expired_and_retained(&options).await?;
        let total = counts.deleted + counts.expired + counts.retained;

        if total > 0 {
            tracing::info!(
                deleted = counts.deleted,
                expired = counts.expired,
                retained = counts.retained,
                "[Maintenance] deleted events"
            );
        }

        Ok(())
    }
}
