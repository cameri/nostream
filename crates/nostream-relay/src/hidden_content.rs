//! The NIP-56 live-hiding mirror. Mirrors `src/utils/hidden-content-cache.ts`.
//!
//! An in-process set of actionable-report targets, consulted on the live-dispatch path only:
//! a snapshot replaces it wholesale, a local mark adds to it immediately, and a periodic
//! tick re-reads it from `ReportRepository::find_actionable_targets` — but only while
//! `nip56.hideActionableReports` is true.
//!
//! The capture keeps module-level sets; here they are [`HiddenContentCache`], owned by the
//! relay, so a test can seed and inspect them.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use nostream_config::settings::Settings;
use nostream_core::clock::Clock;
use nostream_core::{Event, EventId, Pubkey};
use nostream_storage::repositories::ActionableTarget;
use nostream_storage::repositories::ReportRepository;

/// The mirror's default refresh interval (`DEFAULT_REFRESH_INTERVAL_MS`,
/// `src/utils/hidden-content-cache.ts:7`).
pub const DEFAULT_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

/// The actionable-report targets this worker believes are hidden.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HiddenTargets {
    pub pubkeys: HashSet<Pubkey>,
    pub event_ids: HashSet<EventId>,
}

/// The in-process mirror of actionable-report targets.
#[derive(Debug, Default)]
pub struct HiddenContentCache {
    targets: RwLock<HiddenTargets>,
    /// Refreshes performed, i.e. ticks that actually queried the repository. A tick with
    /// `hideActionableReports` false queries nothing and does not count.
    refreshes: Mutex<u64>,
}

impl HiddenContentCache {
    /// An empty mirror.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Whether an event's author or id is a hidden target (`isHidden`).
    pub fn is_hidden(&self, event: &Event) -> bool {
        let targets = self
            .targets
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        targets.pubkeys.contains(&event.pubkey) || targets.event_ids.contains(&event.id)
    }

    /// Adds one target ahead of the next refresh (`markActionableTarget`).
    pub fn mark_actionable_target(&self, target: &ActionableTarget) {
        let mut targets = self
            .targets
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if let Some(pubkey) = target.reported_pubkey {
            targets.pubkeys.insert(pubkey);
        }

        if let Some(event_id) = target.reported_event_id {
            targets.event_ids.insert(event_id);
        }
    }

    /// Replaces the whole mirror with one snapshot (`refreshFromDatabase`).
    pub fn replace(&self, snapshot: &[ActionableTarget]) {
        let next = HiddenTargets {
            pubkeys: snapshot
                .iter()
                .filter_map(|target| target.reported_pubkey)
                .collect(),
            event_ids: snapshot
                .iter()
                .filter_map(|target| target.reported_event_id)
                .collect(),
        };

        *self
            .targets
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = next;
    }

    /// The current snapshot, for tests.
    pub fn snapshot(&self) -> HiddenTargets {
        self.targets
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// How many refreshes have queried the repository. The parity harness polls this; it is
    /// not a metric.
    pub fn refreshes(&self) -> u64 {
        *self
            .refreshes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// One refresh tick: queries the repository only while `hide_actionable_reports` holds,
    /// then replaces the mirror with the snapshot (`startHiddenContentCache`'s
    /// `pollIfEnabled`).
    pub async fn refresh(
        &self,
        repository: &dyn ReportRepository,
        settings: &Settings,
    ) -> Result<(), nostream_storage::StorageError> {
        let hiding = settings
            .nip56
            .as_ref()
            .is_some_and(|nipp56| nipp56.enabled && nipp56.hide_actionable_reports);

        if !hiding {
            return Ok(());
        }

        let snapshot = repository.find_actionable_targets().await?;

        self.replace(&snapshot);

        *self
            .refreshes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) += 1;

        Ok(())
    }

    /// Seeds the mirror, then re-reads it on `interval` until the returned handle is
    /// **aborted** (dropping it detaches the task rather than stopping it, so the caller owns
    /// the handle and [`crate::relay::Relay::serve`] aborts it when its loop ends).
    ///
    /// `interval` is injectable (`startHiddenContentCache`'s third argument); the daemon
    /// passes [`DEFAULT_REFRESH_INTERVAL`].
    pub fn start(
        self: &Arc<Self>,
        repository: Arc<dyn ReportRepository>,
        settings: Arc<Settings>,
        interval: Duration,
        clock: Arc<dyn Clock>,
    ) -> tokio::task::JoinHandle<()> {
        let cache = Arc::clone(self);

        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);

            loop {
                ticker.tick().await;

                if let Err(error) = cache.refresh(repository.as_ref(), settings.as_ref()).await {
                    tracing::warn!(
                        error = %error,
                        now = clock.now_secs(),
                        "failed to refresh the hidden-content cache"
                    );
                }
            }
        })
    }
}
