import { andThen, otherwise, path, pipe } from 'ramda'

import {
  broadcastEvent,
  getPublicKey,
  getRelayPrivateKey,
  identifyEvent,
  signEvent,
  toNostrEvent,
} from '../utils/event'
import { DvmJob, DvmJobStatus } from '../@types/dvm'
import { DvmWorker, Settings } from '../@types/settings'
import { Event, UnidentifiedEvent } from '../@types/event'
import { EventKinds, EventTags } from '../constants/base'
import { IDvmJobRepository, IEventRepository } from '../@types/repositories'
import { spawnWorkerProcess, WorkerProcessHandle, WorkerSpawnErrorReason } from '../cli/utils/process'
import { createLogger } from '../factories/logger-factory'
import { IRunnable } from '../@types/base'
import { shutdownMetricsTelemetry } from '../telemetry/metrics'

const logger = createLogger('dvm-orchestrator-worker')

const POLL_INTERVAL_MS = 2000
const DEFAULT_JOB_TIMEOUT_MS = 30000

type PendingJob = {
  job: DvmJob
  requestEvent: Event
  timer: NodeJS.Timeout
}

export class DvmOrchestratorWorker implements IRunnable {
  private config: DvmWorker | undefined
  private interval: NodeJS.Timeout | undefined
  private isRunning = false
  private closing = false
  private worker: WorkerProcessHandle | undefined
  private readonly pending = new Map<string, PendingJob>()

  public constructor(
    private readonly process: NodeJS.Process,
    private readonly settings: () => Settings,
    private readonly dvmJobRepository: IDvmJobRepository,
    private readonly eventRepository: IEventRepository,
  ) {
    this.process
      .on('SIGINT', this.onExit.bind(this))
      .on('SIGHUP', this.onExit.bind(this))
      .on('SIGTERM', this.onExit.bind(this))
      .on('uncaughtException', this.onError.bind(this))
      .on('unhandledRejection', this.onError.bind(this))
  }

  public run(): void {
    const currentSettings = this.settings()

    this.config = path(['dvm', 'workers', this.process.env.DVM_WORKER_INDEX], currentSettings) as DvmWorker | undefined

    if (!this.config) {
      logger.error('no dvm worker config found for index %s', this.process.env.DVM_WORKER_INDEX)
      this.process.exit(1)
      return
    }

    logger.info('dvm-orchestrator worker started for command: %s', this.config.command)

    this.ensureWorkerProcess()

    this.interval = setInterval(async () => {
      if (this.isRunning) {
        logger('skipping scheduled dispatch because previous run is still in progress')
        return
      }

      this.isRunning = true
      try {
        await this.dispatchNextJob()
      } catch (error) {
        this.onError(error as Error)
      } finally {
        this.isRunning = false
      }
    }, POLL_INTERVAL_MS)
  }

  // One long-lived worker process per configured dvm.workers[i], multiplexing
  // every in-flight job over a single newline-delimited-JSON stdin/stdout pipe
  // (per issue #731 — process.ts's one-shot spawn helpers buffer all output
  // into a single string, which doesn't work once more than one job can be
  // in flight against the same worker at a time).
  private ensureWorkerProcess(): void {
    if (this.worker || !this.config || this.closing) {
      return
    }

    const worker = spawnWorkerProcess(this.config.command, this.config.args ?? [])
    worker.onMessage((message) => this.handleWorkerMessage(message))
    worker.onExit((code, signal) => this.handleWorkerExit(code, signal))
    worker.onSpawnError((reason) => this.handleWorkerSpawnError(reason))
    this.worker = worker
  }

  private async dispatchNextJob(): Promise<void> {
    if (!this.config) {
      return
    }

    // Lazily respawn if the worker process died since the last tick.
    this.ensureWorkerProcess()
    if (!this.worker) {
      return
    }

    const [job] = await this.dvmJobRepository.findPendingJobs(1, this.config.kinds)
    if (!job) {
      return
    }

    const assigned = await this.dvmJobRepository.assignWorker(job.id, this.workerIndex())
    if (!assigned) {
      // Lost the race to another worker instance polling the same job — try again next tick.
      return
    }

    logger('picked up job %s (kind %d)', job.id, job.kind)

    const [row] = await this.eventRepository.findByFilters([{ ids: [job.id] }])
    if (!row) {
      await this.failJob(job.id, 'source event not found')
      return
    }

    const requestEvent = toNostrEvent(row)
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
    const timer = setTimeout(() => this.handleJobTimeout(job.id), timeoutMs)
    this.pending.set(job.id, { job, requestEvent, timer })

    this.worker.send({
      id: requestEvent.id,
      kind: requestEvent.kind,
      pubkey: requestEvent.pubkey,
      tags: requestEvent.tags,
      content: requestEvent.content,
    })
  }

  // The worker replies on the same pipe with { id: <job id>, content: <string> },
  // correlated back to the job that's still pending — replies for jobs we no
  // longer track (already timed out, or from a previous worker instance) are
  // dropped rather than treated as an error.
  private handleWorkerMessage(message: unknown): void {
    const jobId = (message as { id?: unknown } | null)?.id
    if (typeof jobId !== 'string') {
      logger.error('ignoring malformed worker message (missing id): %o', message)
      return
    }

    const pending = this.pending.get(jobId)
    if (!pending) {
      return
    }

    clearTimeout(pending.timer)
    this.pending.delete(jobId)

    const rawContent = (message as { content?: unknown }).content
    const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(message)

    void this.publishResult(pending.job, pending.requestEvent, content)
  }

  private handleJobTimeout(jobId: string): void {
    const pending = this.pending.get(jobId)
    if (!pending) {
      return
    }

    this.pending.delete(jobId)
    void this.failJob(jobId, 'worker timeout', true)

    // Soft Node-level guard per issue #731: kill the worker process on timeout.
    // Any other jobs still in flight on it fail as a side effect of the exit
    // handler below; ensureWorkerProcess() respawns on the next dispatch tick.
    this.worker?.kill()
  }

  private handleWorkerExit(code: number | null, signal: NodeJS.Signals | null): void {
    logger.error('dvm worker process exited (code=%s, signal=%s)', code, signal)
    this.worker = undefined

    for (const [jobId, pending] of this.pending) {
      clearTimeout(pending.timer)
      void this.failJob(jobId, `worker exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
    }
    this.pending.clear()
  }

  private handleWorkerSpawnError(reason: WorkerSpawnErrorReason): void {
    logger.error('unable to spawn dvm worker process: %s', reason)
    this.worker = undefined
  }

  private workerIndex(): number {
    return Number(this.process.env.DVM_WORKER_INDEX)
  }

  private async failJob(jobId: string, error: string, timedOut = false): Promise<void> {
    logger.error('job %s failed: %s', jobId, error)
    try {
      await this.dvmJobRepository.updateStatus({
        id: jobId,
        status: timedOut ? DvmJobStatus.TIMED_OUT : DvmJobStatus.FAILED,
        error,
      })
    } catch (updateError) {
      logger.error('unable to update failed job %s: %o', jobId, updateError)
    }
  }

  // Relay-authored, matching the same self-signing pattern used for invoice
  // notifications (payments-service.ts) and NIP-89 authoring: the settings
  // schema has no per-worker signing key, so the relay's own derived keypair
  // is the DVM identity for every locally-bridged worker.
  private async publishResult(job: DvmJob, requestEvent: Event, content: string): Promise<void> {
    const currentSettings = this.settings()
    const relayPrivkey = getRelayPrivateKey(currentSettings.info.relay_url)
    const relayPubkey = getPublicKey(relayPrivkey)

    const unsignedEvent: UnidentifiedEvent = {
      pubkey: relayPubkey,
      kind: (requestEvent.kind + 1000) as EventKinds,
      created_at: Math.floor(Date.now() / 1000),
      content,
      tags: [
        [EventTags.Event, requestEvent.id],
        [EventTags.Pubkey, requestEvent.pubkey],
      ],
    }

    const persistEvent = async (event: Event) => {
      await this.eventRepository.create(event)
      return event
    }

    const markCompleted = async (event: Event) => {
      await this.dvmJobRepository.updateStatus({
        id: job.id,
        status: DvmJobStatus.COMPLETED,
        resultEventId: event.id,
      })
      return event
    }

    const logPublishError = async (error: Error) => {
      logger.error('unable to publish result for job %s: %o', job.id, error)
      await this.failJob(job.id, `unable to publish result: ${error.message}`)
    }

    await pipe(
      identifyEvent,
      andThen(signEvent(relayPrivkey)),
      andThen(persistEvent),
      andThen(broadcastEvent),
      andThen(markCompleted),
      otherwise(logPublishError),
    )(unsignedEvent)
  }

  private onError(error: Error) {
    logger('error: %o', error)
    throw error
  }

  private onExit() {
    logger('exiting')
    void shutdownMetricsTelemetry().finally(() => {
      this.close(() => {
        this.process.exit(0)
      })
    })
  }

  public close(callback?: () => void) {
    logger('closing')
    this.closing = true
    if (this.interval) {
      clearInterval(this.interval)
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
    }
    this.pending.clear()
    this.worker?.kill()
    if (typeof callback === 'function') {
      callback()
    }
  }
}
