import { ICacheAdapter } from '../@types/adapters'
import { AdminOpsWorkerHeartbeat } from '../@types/admin-ops'
import { IRunnable } from '../@types/base'
import { IRelayProbeSnapshotStore, RelayProbeRunSnapshot } from '../@types/relay-probe-snapshot'
import { Settings } from '../@types/settings'
import { createLogger } from '../factories/logger-factory'
import { INip66EventPublisher } from '../services/nip66-event-publisher'
import { recordProbeRunMetrics } from '../telemetry/ops-metrics'
import { shutdownMetricsTelemetry } from '../telemetry/metrics'
import { notifyProbeRunTransition } from '../utils/ops-trust-notifications'
import { ADMIN_OPS_HEARTBEAT_KEEPALIVE_MS, publishAdminOpsWorkerHeartbeatSafely } from '../utils/admin-ops-store'
import { getMonitorPrivateKey } from '../utils/monitor-identity'
import { getEffectiveProbeIntervalSeconds, getNip66HistoryRetention, getProbeIntervalMs } from '../utils/nip66-schedule'
import { runProbe } from '../utils/relay-probe'
import { ProbeOptions, ProbeResult } from '../utils/relay-probe/types'
import { RelayProbeHistoryStore } from '../utils/relay-probe-history'
import { deriveRelayProbeRunStatus, serializeProbeResults } from '../utils/relay-probe-snapshot'
import {
  filterValidProbeTargets,
  resolveProbeTargets,
  resolvePublicProbeTargetKeys,
} from '../utils/relay-probe-targets'

const logger = createLogger('relay-monitor-worker')

export type RunProbeFn = (relayUrl: string, options?: ProbeOptions) => Promise<ProbeResult>

export const buildProbeOptions = (settings: Settings): ProbeOptions => {
  const nip66 = settings.nip66
  const monitorPrivateKey = getMonitorPrivateKey()

  return {
    timeouts: nip66?.timeouts,
    dnsCacheTtlSeconds: nip66?.dnsCacheTtlSeconds,
    ...(monitorPrivateKey ? { monitorPrivateKey } : {}),
  }
}

export { getProbeIntervalMs } from '../utils/nip66-schedule'

type RelayMonitorOpsHeartbeatFields = Pick<
  AdminOpsWorkerHeartbeat,
  'lastRunStartedAt' | 'lastRunFinishedAt' | 'lastError'
>

export class RelayMonitorWorker implements IRunnable {
  private interval: NodeJS.Timeout | undefined
  private opsKeepaliveInterval: NodeJS.Timeout | undefined
  private isRunning = false
  private lastOpsWorkerHeartbeat: RelayMonitorOpsHeartbeatFields = {}

  public constructor(
    private readonly process: NodeJS.Process,
    private readonly settings: () => Settings,
    private readonly snapshotStore: IRelayProbeSnapshotStore,
    private readonly probeRunner: RunProbeFn = runProbe,
    private readonly eventPublisher?: INip66EventPublisher,
    private readonly historyStore?: RelayProbeHistoryStore,
    private readonly opsCache?: ICacheAdapter,
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

    if (this.opsCache) {
      this.opsKeepaliveInterval = setInterval(() => {
        this.publishOpsKeepalive()
      }, ADMIN_OPS_HEARTBEAT_KEEPALIVE_MS)
    }
  }

  private publishOpsKeepalive(): void {
    if (!this.opsCache || this.lastOpsWorkerHeartbeat.lastRunStartedAt === undefined) {
      return
    }

    void publishAdminOpsWorkerHeartbeatSafely(this.opsCache, {
      type: 'relay-monitor',
      updatedAt: new Date().toISOString(),
      ...this.lastOpsWorkerHeartbeat,
    })
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

  private async publishOpsHeartbeat(partial: RelayMonitorOpsHeartbeatFields): Promise<void> {
    if (!this.opsCache) {
      return
    }

    this.lastOpsWorkerHeartbeat = {
      ...this.lastOpsWorkerHeartbeat,
      ...partial,
    }
    if ('lastError' in partial && partial.lastError === undefined) {
      delete this.lastOpsWorkerHeartbeat.lastError
    }

    await publishAdminOpsWorkerHeartbeatSafely(this.opsCache, {
      type: 'relay-monitor',
      updatedAt: new Date().toISOString(),
      ...this.lastOpsWorkerHeartbeat,
    })
  }

  private async onSchedule(): Promise<void> {
    const probeRunStartedMs = Date.now()
    const lastRunStartedAt = new Date().toISOString()
    await this.publishOpsHeartbeat({ lastRunStartedAt })

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
      await this.publishOpsHeartbeat({
        lastRunStartedAt,
        lastRunFinishedAt: new Date().toISOString(),
        lastError: 'No valid probe targets configured',
      })
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
      await this.publishOpsHeartbeat({
        lastRunStartedAt,
        lastRunFinishedAt: new Date().toISOString(),
        lastError: 'Probe run produced no results',
      })
      return
    }

    const publicTargetKeys = resolvePublicProbeTargetKeys(currentSettings)

    const snapshot: RelayProbeRunSnapshot = {
      runAt: new Date().toISOString(),
      targets: valid,
      results: serializeProbeResults(results),
      status: deriveRelayProbeRunStatus(results),
      probeContext: {
        configuredRelayUrl: currentSettings.info?.relay_url,
        publicTargetKeys: [...publicTargetKeys],
      },
    }

    const expirySeconds = getEffectiveProbeIntervalSeconds(currentSettings) * 2

    await this.snapshotStore.saveLatest(snapshot, expirySeconds)
    recordProbeRunMetrics(snapshot.status, Date.now() - probeRunStartedMs)
    await notifyProbeRunTransition(this.opsCache, snapshot)
    if (this.historyStore) {
      try {
        await this.historyStore.append(snapshot, getNip66HistoryRetention(currentSettings))
      } catch (error) {
        logger.error('failed to save probe history: %o', error)
      }
    }
    logger('saved probe snapshot for %d target(s) with status %s', valid.length, snapshot.status)

    if (this.eventPublisher) {
      try {
        await this.eventPublisher.publishAfterProbe(snapshot, currentSettings)
      } catch (error) {
        logger.error('failed to publish NIP-66 events: %o', error)
      }
    }

    await this.publishOpsHeartbeat({
      lastRunStartedAt,
      lastRunFinishedAt: new Date().toISOString(),
      lastError: undefined,
    })
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
    clearInterval(this.opsKeepaliveInterval)
    if (typeof callback === 'function') {
      callback()
    }
  }
}
