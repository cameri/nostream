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

export class SnapshotService {
  private metricsFingerprint = JSON.stringify(defaultMetrics())

  private sequence = 0

  private snapshot: KPISnapshot = {
    sequence: this.sequence,
    generatedAt: new Date(0).toISOString(),
    status: 'live',
    metrics: defaultMetrics(),
  }

  public constructor(private readonly collector: IKPICollector) { }

  public getSnapshot(): KPISnapshot {
    return this.snapshot
  }

  /**
   * Fetches fresh metrics from the collector and updates the snapshot if the
   * metrics have changed.  Throws if the collector is unavailable — callers
   * are responsible for catching and deciding how to surface errors.
   */
  public async refresh(): Promise<ISnapshotRefreshResult> {
    const metrics = await this.collector.collectMetrics()
    const nextFingerprint = JSON.stringify(metrics)

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
