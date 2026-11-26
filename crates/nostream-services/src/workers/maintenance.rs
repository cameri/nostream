//! `maintenance-worker.ts`: the recurring pass.
//!
//! A tick starts the retention purge, re-verifies NIP-05, walks the notification outbox and
//! prunes it, then — when payments are enabled — walks the pending invoices. The purge runs
//! concurrently and is awaited last, capped at [`CLEAR_OLD_EVENTS_TIMEOUT_MS`]. A pass error
//! is logged and leaves the loop running; a tick that lands while a pass is still running is
//! skipped.
//!
//! A purge that outlives its cap is kept, not detached (#1103): the next pass waits on it again
//! rather than starting a second one, so a store whose cleanup is slower than the interval has
//! one purge running, never one per tick. The capture detaches it (`Promise.race` cannot cancel
//! the losing promise); this is a deliberate divergence. The cost is that a purge that never
//! returns holds retention until it does or the relay restarts — nothing aborts it, because
//! cancelling a store write midway is not a decision for this loop — so every pass that waits on
//! it logs how many passes it has waited.

use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::task::JoinHandle;

use nostream_config::Settings;
use nostream_config::settings::Nip05Mode;
use nostream_core::clock::Clock;
use nostream_core::lifecycle::ShutdownState;
use nostream_core::nip05::{Nip05Fetch, VerificationOutcome, verify};
use nostream_storage::repositories::{EventPurgeCounts, Nip05Verification};

use crate::context::ServiceContext;
use crate::error::ServicesError;
use crate::payments::{PaymentProcessor, resolve};
use crate::scheduler::WorkerSpec;
use crate::services::maintenance_service::MaintenanceService;
use crate::services::notification_outbox_service::{
    NOTIFICATION_OUTBOX_BATCH_SIZE, NotificationOutboxService,
};
use crate::services::operator_notification_service::OperatorNotificationService;
use crate::services::payments_service::PaymentsService;
use crate::unavailable::ServiceStores;

/// The pass interval (`UPDATE_INVOICE_INTERVAL`, `src/app/maintenance-worker.ts:35`).
pub const DEFAULT_MAINTENANCE_INTERVAL_MS: u64 = 60_000;

/// The purge's cap (`CLEAR_OLD_EVENTS_TIMEOUT_MS`, `src/app/maintenance-worker.ts:37`).
pub const CLEAR_OLD_EVENTS_TIMEOUT_MS: u64 = 5_000;

/// The NIP-05 batch (`NIP05_REVERIFICATION_BATCH_SIZE`, `src/app/maintenance-worker.ts:36`).
pub const NIP05_REVERIFICATION_BATCH_SIZE: u64 = 50;

/// The re-verification frequency when settings omit it
/// (`DEFAULT_NIP05_VERIFY_UPDATE_FREQUENCY_MS`, `src/utils/nip05.ts:22`).
pub const DEFAULT_NIP05_UPDATE_FREQUENCY_MS: i64 = 86_400_000;

/// The failure ceiling when settings omit it (`DEFAULT_NIP05_MAX_CONSECUTIVE_FAILURES`,
/// `src/utils/nip05.ts:23`).
pub const DEFAULT_NIP05_MAX_CONSECUTIVE_FAILURES: i32 = 20;

/// The delivery-log retention when settings omit it (`src/app/maintenance-worker.ts:288`).
pub const DEFAULT_DELIVERY_LOG_RETENTION_DAYS: i64 = 30;

/// What one pass did, for the loop's log line and for the tests that pin the steps: whether it
/// started a purge or waited on one an earlier pass started, whether that purge outlived the
/// cap, and the counts the store answered when it completed. A failed or timed-out purge has no
/// counts — zeros there would read as a pass that found nothing to do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PassOutcome {
    pub purge_started: bool,
    pub purge_timed_out: bool,
    pub counts: Option<EventPurgeCounts>,
}

/// A purge the worker owns, so a timed-out one is still known to be running.
type PurgeHandle = JoinHandle<Result<EventPurgeCounts, ServicesError>>;

/// A purge that outlived its pass, and how many passes have timed out waiting on it.
struct OutstandingPurge {
    handle: PurgeHandle,
    passes_waited: u64,
}

/// The four steps, so a test can instrument their order without a store or a network.
pub trait MaintenanceTasks: Send + Sync {
    fn clear_old_events(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<EventPurgeCounts, ServicesError>> + Send + '_>>;
    fn reverify_nip05(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + '_>>;
    fn process_notification_outbox(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + '_>>;
    fn walk_invoices(&self)
    -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + '_>>;
}

/// The pass loop.
pub struct MaintenanceWorker {
    settings: Arc<Settings>,
    tasks: Arc<dyn MaintenanceTasks>,
    interval: Duration,
    purge_timeout: Duration,
    running: AtomicBool,
    /// A purge that outlived its pass's cap and has not been seen to finish.
    outstanding_purge: Mutex<Option<OutstandingPurge>>,
}

impl MaintenanceWorker {
    /// Builds the worker.
    pub fn new(
        settings: Arc<Settings>,
        tasks: Arc<dyn MaintenanceTasks>,
        interval: Duration,
        purge_timeout: Duration,
    ) -> Self {
        Self {
            settings,
            tasks,
            interval,
            purge_timeout,
            running: AtomicBool::new(false),
            outstanding_purge: Mutex::new(None),
        }
    }

    /// One pass, in the capture's order.
    ///
    /// The purge is the one an earlier pass left running, when there is one; otherwise this
    /// pass starts it. Passes must not overlap or be cancelled midway — [`Self::run`] runs one
    /// at a time, to completion. Between taking the held purge and storing it back, its handle
    /// lives only in this pass: a pass dropped there detaches it again (the purge keeps running,
    /// untracked, and the next pass starts another), and an overlapping pass finds no held purge
    /// and starts its own.
    pub async fn run_pass(&self) -> PassOutcome {
        let (mut purge, passes_waited, purge_started) = match self.take_outstanding_purge() {
            Some(previous) if !previous.handle.is_finished() => {
                // On the first wait and every tenth after it, so a purge that never returns
                // does not write a warning every minute; the cap's own error is per pass.
                if previous.passes_waited == 1 || previous.passes_waited % 10 == 0 {
                    tracing::warn!(
                        passes_waited = previous.passes_waited,
                        "the previous retention purge is still running; this pass waits on it instead of starting another"
                    );
                } else {
                    tracing::debug!(
                        passes_waited = previous.passes_waited,
                        "the previous retention purge is still running"
                    );
                }

                (previous.handle, previous.passes_waited, false)
            }
            finished => {
                // It ended between passes: its result is already there and nothing awaits it,
                // so read it now rather than lose it.
                if let Some(previous) = finished {
                    log_late_purge(previous.handle.await);
                }

                let purge_tasks = Arc::clone(&self.tasks);
                let purge = tokio::spawn(async move { purge_tasks.clear_old_events().await });

                (purge, 0, true)
            }
        };

        // Give the purge its first poll so the order is the capture's: started, then the
        // remaining steps, then awaited.
        tokio::task::yield_now().await;

        if let Err(error) = self.tasks.reverify_nip05().await {
            tracing::error!(error = %error, "NIP-05 re-verification batch failed");
        }

        if let Err(error) = self.tasks.process_notification_outbox().await {
            tracing::error!(error = %error, "Unable to process notification outbox");
        }

        if self.payments_enabled()
            && let Err(error) = self.tasks.walk_invoices().await
        {
            tracing::error!(error = %error, "Unable to walk pending invoices");
        }

        let (purge_timed_out, counts) =
            match tokio::time::timeout(self.purge_timeout, &mut purge).await {
                Ok(Ok(Ok(counts))) => (false, Some(counts)),
                Ok(Ok(Err(error))) => {
                    tracing::error!(error = %error, "unable to clear old events");
                    (false, None)
                }
                Ok(Err(error)) => {
                    tracing::error!(error = %error, "the retention task ended abnormally");
                    (false, None)
                }
                Err(_) => {
                    tracing::error!(
                        timeout_ms = self.purge_timeout.as_millis(),
                        "unable to clear old events: clearOldEvents timed out"
                    );
                    // Keep it: dropping the handle would detach a purge that is still working.
                    self.store_outstanding_purge(OutstandingPurge {
                        handle: purge,
                        passes_waited: passes_waited.saturating_add(1),
                    });
                    (true, None)
                }
            };

        PassOutcome {
            purge_started,
            purge_timed_out,
            counts,
        }
    }

    fn take_outstanding_purge(&self) -> Option<OutstandingPurge> {
        self.outstanding_purge
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }

    /// Holds a timed-out purge. The slot is empty here unless two passes overlapped; then the
    /// other pass's purge is kept rather than overwritten, since dropping a handle detaches a
    /// purge that is still working — the defect this slot exists to remove — and this one is
    /// left untracked instead, loudly.
    fn store_outstanding_purge(&self, purge: OutstandingPurge) {
        let mut slot = self
            .outstanding_purge
            .lock()
            .unwrap_or_else(PoisonError::into_inner);

        debug_assert!(slot.is_none(), "two maintenance passes overlapped");

        if slot.is_some() {
            tracing::error!(
                "two maintenance passes overlapped; a timed-out retention purge is no longer tracked"
            );
            return;
        }

        *slot = Some(purge);
    }

    fn payments_enabled(&self) -> bool {
        self.settings
            .payments
            .as_ref()
            .is_some_and(|payments| payments.enabled)
    }

    /// The loop: one tick at a time, skipping a tick while a pass is running.
    pub async fn run(self: Arc<Self>, shutdown: ShutdownState) -> Result<(), ServicesError> {
        let mut ticker =
            tokio::time::interval_at(tokio::time::Instant::now() + self.interval, self.interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                _ = shutdown.wait_for_drain() => return Ok(()),
                _ = ticker.tick() => {
                    if self.running.swap(true, Ordering::SeqCst) {
                        tracing::debug!(
                            "skipping scheduled maintenance run because the previous run is still in progress"
                        );
                        continue;
                    }

                    let outcome = self.run_pass().await;
                    self.running.store(false, Ordering::SeqCst);
                    tracing::debug!(?outcome, "maintenance pass finished");
                }
            }
        }
    }
}

/// Logs the result of a purge that finished after its own pass stopped waiting for it.
fn log_late_purge(result: Result<Result<EventPurgeCounts, ServicesError>, tokio::task::JoinError>) {
    match result {
        Ok(Ok(counts)) => tracing::info!(
            deleted = counts.deleted,
            expired = counts.expired,
            retained = counts.retained,
            "a retention purge that outlived its pass finished"
        ),
        Ok(Err(error)) => {
            tracing::error!(error = %error, "unable to clear old events");
        }
        Err(error) => {
            tracing::error!(error = %error, "the retention task ended abnormally");
        }
    }
}

/// The production steps, over the stores and the two services.
pub struct MaintenanceRunner {
    settings: Arc<Settings>,
    clock: Arc<dyn Clock>,
    stores: Arc<ServiceStores>,
    fetch: Arc<dyn Nip05Fetch>,
    outbox: Arc<NotificationOutboxService>,
    payments: Arc<PaymentsService>,
    invoice_offset: AtomicU64,
}

impl MaintenanceRunner {
    /// Builds the steps.
    pub fn new(
        settings: Arc<Settings>,
        clock: Arc<dyn Clock>,
        stores: Arc<ServiceStores>,
        fetch: Arc<dyn Nip05Fetch>,
        outbox: Arc<NotificationOutboxService>,
        payments: Arc<PaymentsService>,
    ) -> Self {
        Self {
            settings,
            clock,
            stores,
            fetch,
            outbox,
            payments,
            invoice_offset: AtomicU64::new(0),
        }
    }

    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(i64::try_from(self.clock.now_ms()).unwrap_or(i64::MAX))
            .unwrap_or(DateTime::UNIX_EPOCH)
    }
}

impl MaintenanceTasks for MaintenanceRunner {
    fn clear_old_events(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<EventPurgeCounts, ServicesError>> + Send + '_>> {
        Box::pin(async move {
            MaintenanceService::new(Arc::clone(&self.stores.events), Arc::clone(&self.settings))
                .clear_old_events()
                .await
        })
    }

    fn reverify_nip05(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + '_>> {
        Box::pin(async move {
            let Some(nip05) = self.settings.nip05.as_ref() else {
                return Ok(());
            };

            if nip05.mode == Nip05Mode::Disabled {
                return Ok(());
            }

            let update_frequency = i64::try_from(
                nip05
                    .verify_update_frequency
                    .unwrap_or(u64::try_from(DEFAULT_NIP05_UPDATE_FREQUENCY_MS).unwrap_or(0)),
            )
            .unwrap_or(DEFAULT_NIP05_UPDATE_FREQUENCY_MS);
            let max_failures = i32::try_from(
                nip05
                    .max_consecutive_failures
                    .unwrap_or(u32::try_from(DEFAULT_NIP05_MAX_CONSECUTIVE_FAILURES).unwrap_or(0)),
            )
            .unwrap_or(DEFAULT_NIP05_MAX_CONSECUTIVE_FAILURES);

            let pending = self
                .stores
                .nip05
                .find_pending_verifications(
                    update_frequency,
                    max_failures,
                    NIP05_REVERIFICATION_BATCH_SIZE,
                )
                .await?;

            for verification in pending {
                let outcome = verify(
                    self.fetch.as_ref(),
                    &verification.nip05,
                    &verification.pubkey.to_string(),
                )
                .await;
                let updated = apply_reverification_outcome(&verification, &outcome, self.now());

                if let Err(error) = self.stores.nip05.upsert(&updated).await {
                    tracing::error!(
                        pubkey = %verification.pubkey,
                        error = %error,
                        "failed to write a NIP-05 verification"
                    );
                }
            }

            Ok(())
        })
    }

    fn process_notification_outbox(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + '_>> {
        Box::pin(async move {
            match self
                .outbox
                .process_batch(NOTIFICATION_OUTBOX_BATCH_SIZE)
                .await
            {
                Ok(delivered) if delivered > 0 => {
                    tracing::info!(delivered, "delivered notification outbox messages");
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::error!(error = %error, "Unable to process notification outbox");
                    return Ok(());
                }
            }

            let retention_days = self
                .settings
                .admin
                .as_ref()
                .and_then(|admin| admin.notifications.as_ref())
                .and_then(|notifications| notifications.delivery_log_retention_days)
                .unwrap_or(DEFAULT_DELIVERY_LOG_RETENTION_DAYS);
            let cutoff = self.now() - chrono::TimeDelta::milliseconds(retention_days * 86_400_000);

            if let Err(error) = self
                .stores
                .notification_delivery_log
                .delete_older_than(cutoff)
                .await
            {
                tracing::error!(error = %error, "Unable to prune the notification delivery log");
            }

            if let Err(error) = self
                .stores
                .notification_outbox
                .delete_terminal_older_than(cutoff)
                .await
            {
                tracing::error!(error = %error, "Unable to prune the notification outbox");
            }

            Ok(())
        })
    }

    fn walk_invoices(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + '_>> {
        Box::pin(async move {
            let mut offset = self.invoice_offset.load(Ordering::SeqCst);
            let outcome = self.payments.walk_pending_invoices(&mut offset).await;
            self.invoice_offset.store(offset, Ordering::SeqCst);

            outcome
        })
    }
}

/// `applyReverificationOutcome`: a definitive outcome updates the verification, a transient
/// error only bumps the failure count so a previously verified author keeps their grace.
pub fn apply_reverification_outcome(
    existing: &Nip05Verification,
    outcome: &VerificationOutcome,
    now: DateTime<Utc>,
) -> Nip05Verification {
    let mut updated = existing.clone();
    updated.last_checked_at = now;
    updated.updated_at = now;

    match outcome {
        VerificationOutcome::Verified => {
            updated.is_verified = true;
            updated.last_verified_at = Some(now);
            updated.failure_count = 0;
        }
        VerificationOutcome::Mismatch | VerificationOutcome::Invalid { .. } => {
            updated.is_verified = false;
            updated.last_verified_at = None;
            updated.failure_count = existing.failure_count.saturating_add(1);
        }
        VerificationOutcome::Error { .. } => {
            updated.failure_count = existing.failure_count.saturating_add(1);
        }
    }

    updated
}

/// Builds the pass and its worker over one context.
pub fn maintenance_worker(
    context: &ServiceContext,
) -> Result<(Arc<MaintenanceWorker>, WorkerSpec), ServicesError> {
    let processor: Arc<dyn PaymentProcessor> =
        resolve(&context.settings, Arc::clone(&context.http))?.into();

    let settings = Arc::clone(&context.settings);
    let clock = Arc::clone(&context.clock);
    let dispatcher = Arc::new(OperatorNotificationService::new(
        Arc::clone(&settings),
        None,
        Arc::clone(&context.stores.notification_delivery_log),
        Arc::clone(&context.http),
        Arc::clone(&clock),
    ));
    let outbox = Arc::new(NotificationOutboxService::new(
        Arc::clone(&context.stores.notification_outbox),
        dispatcher.clone(),
        dispatcher.max_attempts(),
        dispatcher.base_delay_ms(),
    ));
    let payments = Arc::new(PaymentsService::new(
        Arc::clone(&settings),
        clock,
        Arc::clone(&context.keys),
        Arc::clone(&context.stores),
        context.hub.clone(),
        processor,
    ));
    let fetch = Arc::clone(&context.fetch);

    let runner = Arc::new(MaintenanceRunner::new(
        Arc::clone(&settings),
        Arc::clone(&context.clock),
        Arc::clone(&context.stores),
        fetch,
        outbox,
        payments,
    ));

    let worker = Arc::new(MaintenanceWorker::new(
        settings,
        runner,
        Duration::from_millis(DEFAULT_MAINTENANCE_INTERVAL_MS),
        Duration::from_millis(CLEAR_OLD_EVENTS_TIMEOUT_MS),
    ));

    let worker_for_loop = Arc::clone(&worker);
    let spec = WorkerSpec::new(
        "maintenance",
        Box::new(move |shutdown| Box::pin(Arc::clone(&worker_for_loop).run(shutdown))),
    );

    Ok((worker, spec))
}
