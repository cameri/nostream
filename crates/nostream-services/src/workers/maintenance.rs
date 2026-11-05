//! `maintenance-worker.ts`: the recurring pass.
//!
//! A tick starts the retention purge, re-verifies NIP-05, walks the notification outbox and
//! prunes it, then — when payments are enabled — walks the pending invoices. The purge runs
//! concurrently and is awaited last, capped at [`CLEAR_OLD_EVENTS_TIMEOUT_MS`]. A pass error
//! is logged and leaves the loop running; a tick that lands while a pass is still running is
//! skipped.

use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use chrono::{DateTime, Utc};

use nostream_config::Settings;
use nostream_config::settings::Nip05Mode;
use nostream_core::clock::Clock;
use nostream_core::lifecycle::ShutdownState;
use nostream_core::nip05::{Nip05Fetch, VerificationOutcome, verify};
use nostream_storage::repositories::Nip05Verification;

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

/// What one pass did, for the loop's log line and for the tests that pin the steps.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PassOutcome {
    pub purge_timed_out: bool,
}

/// The four steps, so a test can instrument their order without a store or a network.
pub trait MaintenanceTasks: Send + Sync {
    fn clear_old_events(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + '_>>;
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
        }
    }

    /// One pass, in the capture's order.
    pub async fn run_pass(&self) -> PassOutcome {
        let purge_tasks = Arc::clone(&self.tasks);
        let purge = tokio::spawn(async move { purge_tasks.clear_old_events().await });

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

        let purge_timed_out = match tokio::time::timeout(self.purge_timeout, purge).await {
            Ok(Ok(Ok(()))) => false,
            Ok(Ok(Err(error))) => {
                tracing::error!(error = %error, "unable to clear old events");
                false
            }
            Ok(Err(error)) => {
                tracing::error!(error = %error, "the retention task ended abnormally");
                false
            }
            Err(_) => {
                tracing::error!(
                    timeout_ms = self.purge_timeout.as_millis(),
                    "unable to clear old events: clearOldEvents timed out"
                );
                true
            }
        };

        PassOutcome { purge_timed_out }
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

                    self.run_pass().await;
                    self.running.store(false, Ordering::SeqCst);
                }
            }
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
    ) -> Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send + '_>> {
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
