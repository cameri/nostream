//! `dvm-orchestrator-worker.ts`: one long-lived worker process per configured
//! `dvm.workers[i]`, multiplexing jobs over one newline-delimited-JSON stdin/stdout pipe.
//!
//! A dispatch tick assigns a pending job, reads its source event and writes the request; a
//! reply correlates by id; a timeout fails the job and kills the process; an exit fails
//! every in-flight job; a shutdown fails them with `worker shutting down` before killing.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::AbortHandle;

use nostream_config::Settings;
use nostream_config::settings::DvmWorker;
use nostream_core::Filter;
use nostream_core::clock::Clock;
use nostream_core::crypto::sign_event;
use nostream_core::event::{Event, EventId, Kind, Signature};
use nostream_core::lifecycle::ShutdownState;
use nostream_relay::relay_key::RelayKeySource;
use nostream_storage::repositories::{
    DvmJob, DvmJobStatus, DvmJobUpdate, EventRecord, FieldUpdate,
};

use crate::context::ServiceContext;
use crate::error::ServicesError;
use crate::scheduler::WorkerSpec;
use crate::unavailable::ServiceStores;

/// The dispatch tick (`POLL_INTERVAL_MS`, `src/app/dvm-orchestrator-worker.ts:23`).
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 2_000;

/// The default per-job timeout (`DEFAULT_JOB_TIMEOUT_MS`, `:24`).
pub const DEFAULT_JOB_TIMEOUT_MS: u64 = 60_000;

/// The dispatch batch (`DISPATCH_BATCH_SIZE`, `:25`).
pub const DISPATCH_BATCH_SIZE: u64 = 10;

/// One configured worker, resolved from `dvm.workers[index]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DvmWorkerConfig {
    pub index: i32,
    pub command: String,
    pub args: Vec<String>,
    pub kinds: Option<Vec<Kind>>,
    pub timeout: Duration,
}

impl DvmWorkerConfig {
    /// The settings entry at `index`, with the capture's defaults.
    pub fn from_settings(index: i32, worker: &DvmWorker) -> Self {
        Self {
            index,
            command: worker.command.clone(),
            args: worker.args.clone().unwrap_or_default(),
            kinds: worker
                .kinds
                .as_ref()
                .map(|kinds| kinds.iter().copied().map(Kind).collect()),
            timeout: Duration::from_millis(worker.timeout_ms.unwrap_or(DEFAULT_JOB_TIMEOUT_MS)),
        }
    }
}

struct PendingJob {
    job: DvmJob,
    request: Event,
    timeout: AbortHandle,
}

struct WorkerHandle {
    stdin: ChildStdin,
    kill: oneshot::Sender<()>,
}

enum WorkerEvent {
    Line(String),
    Timeout {
        id: EventId,
    },
    Exit {
        code: Option<i32>,
        signal: Option<i32>,
    },
}

/// One DVM orchestrator.
pub struct DvmOrchestrator {
    settings: Arc<Settings>,
    stores: Arc<ServiceStores>,
    keys: Arc<RelayKeySource>,
    clock: Arc<dyn Clock>,
    hub: broadcast::Sender<Arc<Event>>,
    config: DvmWorkerConfig,
    poll_interval: Duration,
    pending: Mutex<HashMap<EventId, PendingJob>>,
    child: tokio::sync::Mutex<Option<WorkerHandle>>,
    events: mpsc::UnboundedSender<WorkerEvent>,
    receiver: Mutex<Option<mpsc::UnboundedReceiver<WorkerEvent>>>,
    running: AtomicBool,
    closing: AtomicBool,
}

impl DvmOrchestrator {
    /// Builds the orchestrator. `spawn_worker` starts the process; `run` calls it.
    pub fn new(
        settings: Arc<Settings>,
        stores: Arc<ServiceStores>,
        keys: Arc<RelayKeySource>,
        clock: Arc<dyn Clock>,
        hub: broadcast::Sender<Arc<Event>>,
        config: DvmWorkerConfig,
        poll_interval: Duration,
    ) -> Self {
        let (events, receiver) = mpsc::unbounded_channel();

        Self {
            settings,
            stores,
            keys,
            clock,
            hub,
            config,
            poll_interval,
            pending: Mutex::new(HashMap::new()),
            child: tokio::sync::Mutex::new(None),
            events,
            receiver: Mutex::new(Some(receiver)),
            running: AtomicBool::new(false),
            closing: AtomicBool::new(false),
        }
    }

    /// The process's command line, for a log line.
    pub fn command(&self) -> &str {
        &self.config.command
    }

    async fn ensure_worker(self: &Arc<Self>) {
        if self.closing.load(Ordering::SeqCst) {
            return;
        }

        let mut slot = self.child.lock().await;

        if slot.is_some() {
            return;
        }

        let mut command = tokio::process::Command::new(&self.config.command);
        command
            .args(&self.config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);

        let mut process = match command.spawn() {
            Ok(process) => process,
            Err(error) => {
                tracing::error!(
                    command = self.config.command,
                    error = %error,
                    "unable to spawn the dvm worker process"
                );
                return;
            }
        };

        let Some(stdin) = process.stdin.take() else {
            tracing::error!("the dvm worker process has no stdin");
            return;
        };
        let Some(stdout) = process.stdout.take() else {
            tracing::error!("the dvm worker process has no stdout");
            return;
        };

        let (kill, killed) = oneshot::channel();
        let events = self.events.clone();
        tokio::spawn(drive_worker(process, stdout, killed, events));

        *slot = Some(WorkerHandle { stdin, kill });
    }

    async fn kill_worker(&self) {
        let mut slot = self.child.lock().await;

        if let Some(handle) = slot.take() {
            let _ = handle.kill.send(());
        }
    }

    async fn send_line(&self, line: &str) -> bool {
        let mut slot = self.child.lock().await;

        let Some(handle) = slot.as_mut() else {
            return false;
        };

        let mut payload = line.to_owned();
        payload.push('\n');

        match handle.stdin.write_all(payload.as_bytes()).await {
            Ok(()) => handle.stdin.flush().await.is_ok(),
            Err(error) => {
                tracing::error!(error = %error, "unable to send a job to the dvm worker process");
                false
            }
        }
    }

    async fn dispatch_next(self: &Arc<Self>) {
        self.ensure_worker().await;

        if self.child.lock().await.is_none() {
            return;
        }

        let candidates = match self
            .stores
            .dvm_jobs
            .find_pending_jobs(DISPATCH_BATCH_SIZE, self.config.kinds.as_deref())
            .await
        {
            Ok(candidates) => candidates,
            Err(error) => {
                tracing::error!(error = %error, "unable to read pending dvm jobs");
                return;
            }
        };

        let mut selected = None;

        for candidate in candidates {
            match self
                .stores
                .dvm_jobs
                .assign_worker(&candidate.id, self.config.index)
                .await
            {
                Ok(true) => {
                    selected = Some(candidate);
                    break;
                }
                Ok(false) => {}
                Err(error) => {
                    tracing::error!(error = %error, "unable to assign a dvm job");
                    return;
                }
            }
        }

        let Some(job) = selected else {
            return;
        };

        let filter = Filter {
            ids: Some(vec![job.id.to_string()]),
            ..Filter::default()
        };
        let record = match self.stores.events.find_by_filters(&[filter]).await {
            Ok(mut stream) => {
                use futures_util::StreamExt;
                stream.next().await.and_then(Result::ok)
            }
            Err(error) => {
                tracing::error!(error = %error, "unable to read a dvm job's source event");
                None
            }
        };

        let job_id = job.id;

        let Some(record) = record else {
            self.fail_job(&job_id, "source event not found", false)
                .await;
            return;
        };

        let request = record.event;
        let timeout = self.config.timeout;
        let events = self.events.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            let _ = events.send(WorkerEvent::Timeout { id: job_id });
        });

        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                job_id,
                PendingJob {
                    job,
                    request: request.clone(),
                    timeout: timer.abort_handle(),
                },
            );

        let message = serde_json::json!({
            "id": request.id.to_string(),
            "kind": request.kind.0,
            "pubkey": request.pubkey.to_string(),
            "tags": request.tags,
            "content": request.content,
        });

        if !self.send_line(&message.to_string()).await {
            timer.abort();
            self.pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&job_id);
            self.fail_job(&job_id, "unable to send job to worker process", false)
                .await;
        }
    }

    async fn handle_worker_message(&self, line: &str) {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
            tracing::error!(line, "ignoring a malformed dvm worker message");
            return;
        };
        let Some(job_id) = message.get("id").and_then(serde_json::Value::as_str) else {
            tracing::error!(line, "ignoring a dvm worker message without an id");
            return;
        };
        let Ok(id) = job_id.parse::<EventId>() else {
            return;
        };

        let pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&id);

        let Some(pending) = pending else {
            // A reply for a job this process no longer tracks: dropped, not an error.
            return;
        };

        pending.timeout.abort();

        let content = message
            .get("content")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| message.to_string());

        self.publish_result(&pending.job, &pending.request, content)
            .await;
    }

    async fn handle_timeout(&self, id: &EventId) {
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);

        if pending.is_none() {
            return;
        }

        self.fail_job(id, "worker timeout", true).await;
        self.kill_worker().await;
    }

    async fn handle_exit(&self, code: Option<i32>, signal: Option<i32>) {
        {
            let mut slot = self.child.lock().await;
            *slot = None;
        }

        let pending: Vec<PendingJob> = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, pending)| pending)
            .collect();

        for pending in pending {
            pending.timeout.abort();
            self.fail_job(
                &pending.job.id,
                &format!(
                    "worker exited (code={}, signal={})",
                    display_option(code),
                    display_option(signal)
                ),
                false,
            )
            .await;
        }
    }

    async fn fail_job(&self, id: &EventId, error: &str, timed_out: bool) {
        tracing::error!(job_id = %id, error, "dvm job failed");

        let update = DvmJobUpdate {
            id: *id,
            status: if timed_out {
                DvmJobStatus::TimedOut
            } else {
                DvmJobStatus::Failed
            },
            result_event_id: FieldUpdate::Absent,
            error: FieldUpdate::Set(error.to_owned()),
        };

        if let Err(error) = self.stores.dvm_jobs.update_status(&update).await {
            tracing::error!(job_id = %id, error = %error, "unable to record a failed dvm job");
        }
    }

    async fn publish_result(&self, job: &DvmJob, request: &Event, content: String) {
        let outcome = async {
            let keys = self
                .keys
                .resolve(&self.settings.info.relay_url)
                .map_err(|error| ServicesError::Dvm(error.to_string()))?;

            let mut event = Event {
                id: EventId::from_byte_array([0; 32]),
                pubkey: keys.public_key,
                created_at: self.clock.now_secs(),
                kind: Kind(request.kind.0 + 1_000),
                content,
                tags: vec![
                    vec!["e".to_owned(), request.id.to_string()],
                    vec!["p".to_owned(), request.pubkey.to_string()],
                ],
                sig: Signature::from_byte_array([0; 64]),
            };
            sign_event(&keys.secret_key, &mut event)
                .map_err(|error| ServicesError::Dvm(error.to_string()))?;

            self.stores
                .events
                .create(&EventRecord::from_event(&event))
                .await?;
            let _ = self.hub.send(Arc::new(event.clone()));

            let update = DvmJobUpdate {
                id: job.id,
                status: DvmJobStatus::Completed,
                result_event_id: FieldUpdate::Set(event.id),
                error: FieldUpdate::Absent,
            };
            self.stores.dvm_jobs.update_status(&update).await?;

            Ok::<(), ServicesError>(())
        }
        .await;

        if let Err(error) = outcome {
            tracing::error!(job_id = %job.id, error = %error, "unable to publish a dvm result");
            self.fail_job(
                &job.id,
                &format!("unable to publish result: {error}"),
                false,
            )
            .await;
        }
    }

    /// Fails every in-flight job, then kills the child. The run loop calls this on drain.
    pub async fn shutdown_worker(&self) {
        self.closing.store(true, Ordering::SeqCst);

        let pending: Vec<PendingJob> = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, pending)| pending)
            .collect();

        for pending in pending {
            pending.timeout.abort();
            self.fail_job(&pending.job.id, "worker shutting down", false)
                .await;
        }

        self.kill_worker().await;
    }

    /// The orchestrator's loop: a dispatch tick, replies, timeouts and exits.
    pub async fn run(self: Arc<Self>, shutdown: ShutdownState) -> Result<(), ServicesError> {
        let Some(mut receiver) = self
            .receiver
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        else {
            return Ok(());
        };

        self.ensure_worker().await;

        let mut ticker = tokio::time::interval_at(
            tokio::time::Instant::now() + self.poll_interval,
            self.poll_interval,
        );
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                _ = shutdown.wait_for_drain() => {
                    self.shutdown_worker().await;
                    return Ok(());
                }
                _ = ticker.tick() => {
                    if !self.running.swap(true, Ordering::SeqCst) {
                        self.dispatch_next().await;
                        self.running.store(false, Ordering::SeqCst);
                    }
                }
                event = receiver.recv() => {
                    match event {
                        Some(WorkerEvent::Line(line)) => self.handle_worker_message(&line).await,
                        Some(WorkerEvent::Timeout { id }) => self.handle_timeout(&id).await,
                        Some(WorkerEvent::Exit { code, signal }) => self.handle_exit(code, signal).await,
                        None => return Ok(()),
                    }
                }
            }
        }
    }
}

/// The child's driver: read stdout lines into the channel, kill on request, then report the
/// exit. Holding `Child` here is what lets both a kill and a wait happen in one place.
async fn drive_worker(
    mut process: Child,
    stdout: tokio::process::ChildStdout,
    mut killed: oneshot::Receiver<()>,
    events: mpsc::UnboundedSender<WorkerEvent>,
) {
    let mut lines = BufReader::new(stdout).lines();

    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        if !line.trim().is_empty() {
                            let _ = events.send(WorkerEvent::Line(line));
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            _ = &mut killed => {
                let _ = process.kill().await;
                break;
            }
        }
    }

    let (code, signal) = match process.wait().await {
        Ok(status) => exit_parts(status),
        Err(_) => (None, None),
    };

    let _ = events.send(WorkerEvent::Exit { code, signal });
}

#[cfg(unix)]
fn exit_parts(status: std::process::ExitStatus) -> (Option<i32>, Option<i32>) {
    use std::os::unix::process::ExitStatusExt;

    (status.code(), status.signal())
}

#[cfg(not(unix))]
fn exit_parts(status: std::process::ExitStatus) -> (Option<i32>, Option<i32>) {
    (status.code(), None)
}

fn display_option(value: Option<i32>) -> String {
    value.map_or_else(|| "null".to_owned(), |value| value.to_string())
}

/// One [`WorkerSpec`] per configured `dvm.workers[i]`.
pub fn dvm_specs(context: &ServiceContext) -> Result<Vec<WorkerSpec>, ServicesError> {
    let Some(workers) = context
        .settings
        .dvm
        .as_ref()
        .and_then(|dvm| dvm.workers.as_ref())
    else {
        return Ok(Vec::new());
    };

    let mut installed = Vec::with_capacity(workers.len());

    for (index, worker) in workers.iter().enumerate() {
        let index = i32::try_from(index).unwrap_or(i32::MAX);
        let config = DvmWorkerConfig::from_settings(index, worker);
        let orchestrator = Arc::new(DvmOrchestrator::new(
            Arc::clone(&context.settings),
            Arc::clone(&context.stores),
            Arc::clone(&context.keys),
            Arc::clone(&context.clock),
            context.hub.clone(),
            config,
            Duration::from_millis(DEFAULT_POLL_INTERVAL_MS),
        ));

        installed.push(WorkerSpec::new(
            "dvm-orchestrator",
            Box::new(move |shutdown| Box::pin(Arc::clone(&orchestrator).run(shutdown))),
        ));
    }

    Ok(installed)
}
