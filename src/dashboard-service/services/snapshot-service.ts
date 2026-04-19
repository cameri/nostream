import { DashboardMetrics, KPISnapshot } from '../types'
import { createLogger } from '../../factories/logger-factory'

const debug = createLogger('dashboard-service:snapshot-service')

const defaultMetrics = (): DashboardMetrics => ({
  eventsByKind: [],
  admittedUsers: 0,
  satsPaid: 0,
  topTalkers: {
    allTime: [],
    recent: [],
  },
})

export interface ISnapshotRefreshResult {
  snapshot: KPISnapshot
  changed: boolean
}

export interface IKPICollector {
  collectMetrics(): Promise<DashboardMetrics>
  close?(): Promise<void> | void
}

export interface IKPIUpdateVersionProvider {
  getCurrentVersion(): Promise<string | undefined>
}

export class SnapshotService {
  private lastCollectedVersion: string | undefined

  private metricsFingerprint = JSON.stringify(defaultMetrics())

  private sequence = 0

  private snapshot: KPISnapshot = {
    sequence: this.sequence,
    generatedAt: new Date(0).toISOString(),
    status: 'live',
    metrics: defaultMetrics(),
  }

  public constructor(
    private readonly collector: IKPICollector,
    private readonly updateVersionProvider?: IKPIUpdateVersionProvider,
  ) { }

  public getSnapshot(): KPISnapshot {
    return this.snapshot
  }

  /**
   * Fetches fresh metrics from the collector and updates the snapshot if the
   * metrics have changed.  Throws if the collector is unavailable — callers
   * are responsible for catching and deciding how to surface errors.
   */
  public async refresh(): Promise<ISnapshotRefreshResult> {
    const currentVersion = await this.updateVersionProvider?.getCurrentVersion()

    if (
      typeof currentVersion !== 'undefined'
      && typeof this.lastCollectedVersion !== 'undefined'
      && currentVersion === this.lastCollectedVersion
      && this.snapshot.status === 'live'
    ) {
      debug('dashboard revision unchanged, skipping KPI collection')
      return {
        snapshot: this.snapshot,
        changed: false,
      }
    }

    const metrics = await this.collector.collectMetrics()
    const nextFingerprint = JSON.stringify(metrics)

    if (typeof currentVersion !== 'undefined') {
      this.lastCollectedVersion = currentVersion
    }

    if (nextFingerprint === this.metricsFingerprint && this.snapshot.status === 'live') {
      debug('metrics unchanged, skipping snapshot sequence update')
      return {
        snapshot: this.snapshot,
        changed: false,
      }
    }

    this.metricsFingerprint = nextFingerprint

    return this.updateSnapshot(metrics, 'live')
  }

  private updateSnapshot(metrics: DashboardMetrics, status: 'live' | 'stale'): ISnapshotRefreshResult {
    this.sequence += 1

    this.snapshot = {
      sequence: this.sequence,
      generatedAt: new Date().toISOString(),
      status,
      metrics,
    }

    return {
      snapshot: this.snapshot,
      changed: true,
    }
  }
}
