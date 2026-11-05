//! The worker model. Mirrors the capture's cluster primary and its per-worker loops
//! (`src/app/app.ts:140-315`, `src/index.ts:11-27`).
//!
//! One [`Supervisor`] runs every registered worker as its own tokio task, restarts a worker
//! that returns an error after [`DEFAULT_RESTART_DELAY`] (unless a drain has begun), leaves a
//! worker that returns `Ok` finished, and on drain waits at most its deadline before aborting
//! what is left. A worker's error never fails the process.

use std::pin::Pin;
use std::time::Duration;

use nostream_core::lifecycle::ShutdownState;
use tokio::task::JoinSet;

use crate::error::ServicesError;

/// The delay before a failed worker is restarted (`src/app/app.ts:250-267`).
pub const DEFAULT_RESTART_DELAY: Duration = Duration::from_millis(10_000);

/// How much longer than `WS_DRAIN_TIMEOUT_MS` the supervisor waits (`R5`).
pub const SUPERVISOR_DRAIN_MARGIN: Duration = Duration::from_millis(5_000);

/// One worker run's future.
pub type WorkerFuture = Pin<Box<dyn Future<Output = Result<(), ServicesError>> + Send>>;

/// Builds a worker's body. Called again on every restart.
pub type WorkerFactory = Box<dyn Fn(ShutdownState) -> WorkerFuture + Send + Sync>;

/// One registered worker.
pub struct WorkerSpec {
    /// The name a restart and a drain log line carries.
    pub name: &'static str,
    pub run: WorkerFactory,
}

impl WorkerSpec {
    /// A worker from its name and body.
    pub fn new(name: &'static str, run: WorkerFactory) -> Self {
        Self { name, run }
    }
}

/// The process's worker supervisor.
pub struct Supervisor {
    shutdown: ShutdownState,
    restart_delay: Duration,
    drain_deadline: Duration,
    specs: Vec<WorkerSpec>,
}

enum TaskEvent {
    /// A worker's body ended.
    Exited {
        index: usize,
        result: Result<(), ServicesError>,
    },
    /// A failed worker's restart delay elapsed.
    Restart { index: usize },
}

impl Supervisor {
    /// A supervisor over `shutdown` with the capture's delays.
    pub fn new(shutdown: ShutdownState) -> Self {
        Self {
            shutdown,
            restart_delay: DEFAULT_RESTART_DELAY,
            drain_deadline: supervisor_drain_deadline_from_env(),
            specs: Vec::new(),
        }
    }

    /// Overrides the restart delay (tests inject a short one).
    pub fn with_restart_delay(mut self, restart_delay: Duration) -> Self {
        self.restart_delay = restart_delay;
        self
    }

    /// Overrides the drain deadline (tests inject a short one).
    pub fn with_drain_deadline(mut self, drain_deadline: Duration) -> Self {
        self.drain_deadline = drain_deadline;
        self
    }

    /// Adds one worker. Called before [`Supervisor::run`].
    pub fn register(&mut self, spec: WorkerSpec) {
        self.specs.push(spec);
    }

    /// How many workers are registered.
    pub fn len(&self) -> usize {
        self.specs.len()
    }

    /// Whether no worker is registered.
    pub fn is_empty(&self) -> bool {
        self.specs.is_empty()
    }

    /// Runs every worker until the drain, and returns `Ok(())` once they are done.
    pub async fn run(self) -> Result<(), ServicesError> {
        let mut tasks: JoinSet<TaskEvent> = JoinSet::new();
        let mut attempts = vec![0u32; self.specs.len()];

        for index in 0..self.specs.len() {
            spawn_worker(&self.specs, index, &self.shutdown, &mut tasks);
        }

        loop {
            tokio::select! {
                _ = self.shutdown.wait_for_drain() => break,
                joined = tasks.join_next() => {
                    let Some(joined) = joined else { break };

                    match joined {
                        Ok(TaskEvent::Exited { index, result }) => {
                            if let Err(error) = result {
                                if self.shutdown.is_draining() {
                                    continue;
                                }

                                attempts[index] += 1;
                                tracing::warn!(
                                    worker = self.specs[index].name,
                                    attempt = attempts[index],
                                    error = %error,
                                    "worker failed; restarting after the restart delay"
                                );
                                let delay = self.restart_delay;
                                tasks.spawn(async move {
                                    tokio::time::sleep(delay).await;
                                    TaskEvent::Restart { index }
                                });
                            }
                        }
                        Ok(TaskEvent::Restart { index }) => {
                            if !self.shutdown.is_draining() {
                                spawn_worker(&self.specs, index, &self.shutdown, &mut tasks);
                            }
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "a worker task ended abnormally");
                        }
                    }
                }
            }
        }

        let deadline = tokio::time::sleep(self.drain_deadline);
        tokio::pin!(deadline);

        while !tasks.is_empty() {
            tokio::select! {
                _ = tasks.join_next() => {}
                _ = &mut deadline => {
                    tracing::warn!(
                        remaining = tasks.len(),
                        "terminating workers after the drain deadline"
                    );
                    tasks.abort_all();
                    break;
                }
            }
        }

        Ok(())
    }
}

fn spawn_worker(
    specs: &[WorkerSpec],
    index: usize,
    shutdown: &ShutdownState,
    tasks: &mut JoinSet<TaskEvent>,
) {
    let future = (specs[index].run)(shutdown.clone());

    tasks.spawn(async move {
        let result = future.await;
        TaskEvent::Exited { index, result }
    });
}

/// The runtime's thread count (`R4`): `WORKER_COUNT` when it parses to a positive integer,
/// else `workers.count` when it is non-zero, else the CPU count.
///
/// A non-numeric or zero `WORKER_COUNT` falls through. The capture's `Number("abc")` is
/// `NaN`, which forks zero client workers; ADR 0010 records why the port refuses that.
pub fn resolve_worker_count(worker_count: Option<&str>, settings_count: u32) -> usize {
    if let Some(raw) = worker_count
        && let Ok(parsed) = raw.trim().parse::<u64>()
        && parsed > 0
    {
        return usize::try_from(parsed).unwrap_or(usize::MAX);
    }

    if settings_count > 0 {
        return usize::try_from(settings_count).unwrap_or(usize::MAX);
    }

    std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1)
}

/// The supervisor's drain deadline: `WS_DRAIN_TIMEOUT_MS` (default 30 000) plus five
/// seconds (`R5`, `V4`).
pub fn supervisor_drain_deadline(drain_timeout: Option<&str>) -> Duration {
    Duration::from_millis(nostream_relay::transport::resolve_drain_timeout(
        drain_timeout,
    )) + SUPERVISOR_DRAIN_MARGIN
}

/// [`supervisor_drain_deadline`] over the process environment.
pub fn supervisor_drain_deadline_from_env() -> Duration {
    supervisor_drain_deadline(std::env::var("WS_DRAIN_TIMEOUT_MS").ok().as_deref())
}
