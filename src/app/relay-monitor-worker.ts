import { IRunnable } from '../@types/base'
import { IRelayProbeSnapshotStore, RelayProbeRunSnapshot } from '../@types/relay-probe-snapshot'
import { Settings } from '../@types/settings'
import { createLogger } from '../factories/logger-factory'
import { shutdownMetricsTelemetry } from '../telemetry/metrics'
import { filterValidProbeTargets, resolveProbeTargets } from '../utils/relay-probe-targets'
import { deriveRelayProbeRunStatus } from '../utils/relay-probe-snapshot'
import { runProbe } from '../utils/relay-probe'
import { ProbeOptions, ProbeResult } from '../utils/relay-probe/types'

const logger = createLogger('relay-monitor-worker')

const DEFAULT_PROBE_INTERVAL_SECONDS = 3600
const MIN_PROBE_INTERVAL_SECONDS = 60

export type RunProbeFn = (relayUrl: string, options?: ProbeOptions) => Promise<ProbeResult>

export const buildProbeOptions = (settings: Settings): ProbeOptions => {
  const nip66 = settings.nip66

  return {
    timeouts: nip66?.timeouts,
    dnsCacheTtlSeconds: nip66?.dnsCacheTtlSeconds,
  }
}

export const getProbeIntervalMs = (settings: Settings): number => {
  const configured = settings.nip66?.probeIntervalSeconds ?? DEFAULT_PROBE_INTERVAL_SECONDS
  const intervalSeconds = Math.max(configured, MIN_PROBE_INTERVAL_SECONDS)

  return intervalSeconds * 1000
}

export class RelayMonitorWorker implements IRunnable {
  private interval: NodeJS.Timeout | undefined
  private isRunning = false

  public constructor(
    private readonly process: NodeJS.Process,
    private readonly settings: () => Settings,
    private readonly snapshotStore: IRelayProbeSnapshotStore,
    private readonly probeRunner: RunProbeFn = runProbe,
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

    if (!currentSettings.nip66?.enabled) {
      logger('NIP-66 relay monitoring is disabled; worker exiting')
      return
    }

    const intervalMs = getProbeIntervalMs(currentSettings)
    logger('starting probe scheduler with interval %d ms', intervalMs)

    void this.runScheduledProbes()

    this.interval = setInterval(() => {
      void this.runScheduledProbes()
    }, intervalMs)
  }

  private async runScheduledProbes(): Promise<void> {
    if (this.isRunning) {
      logger('skipping scheduled probe run because previous run is still in progress')
      return
    }

    this.isRunning = true

    try {
      await this.onSchedule()
    } catch (error) {
      this.onError(error as Error)
    } finally {
      this.isRunning = false
    }
  }

  private async onSchedule(): Promise<void> {
    const currentSettings = this.settings()

    if (!currentSettings.nip66?.enabled) {
      logger('NIP-66 relay monitoring disabled during scheduled run; stopping scheduler')
      this.close()
      return
    }

    const configuredTargets = resolveProbeTargets(currentSettings)
    const { valid, invalid } = filterValidProbeTargets(configuredTargets)

    for (const target of invalid) {
      logger.warn('skipping invalid probe target: %s', target)
    }

    if (valid.length === 0) {
      logger.warn('no valid probe targets configured; skipping probe run')
      return
    }

    const probeOptions = buildProbeOptions(currentSettings)
    const results: ProbeResult[] = []

    for (const target of valid) {
      try {
        results.push(await this.probeRunner(target, probeOptions))
      } catch (error) {
        logger.error('probe run failed for %s: %o', target, error)
      }
    }

    if (results.length === 0) {
      logger.warn('probe run produced no results')
      return
    }

    const snapshot: RelayProbeRunSnapshot = {
      runAt: new Date().toISOString(),
      targets: valid,
      results,
      status: deriveRelayProbeRunStatus(results),
    }

    const expirySeconds = Math.max(
      (currentSettings.nip66?.probeIntervalSeconds ?? DEFAULT_PROBE_INTERVAL_SECONDS) * 2,
      MIN_PROBE_INTERVAL_SECONDS * 2,
    )

    await this.snapshotStore.saveLatest(snapshot, expirySeconds)
    logger('saved probe snapshot for %d target(s) with status %s', valid.length, snapshot.status)
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
    clearInterval(this.interval)
    if (typeof callback === 'function') {
      callback()
    }
  }
}
