import { AdminDependencyHealth, collectAdminHealthSnapshot } from './admin-health'
import { queryPrometheusInstant } from './prometheus-client'

export interface AdminMetricsValues {
  eventsPerSecond: number
  eventsRejectedPerSecond: number
  eventsAcceptedTotal: number
  eventsRejectedTotal: number
  activeConnections: number
  cpuLoadPercent: number
  memoryUsedMb: number
}

export interface AdminMetricsSnapshot {
  timestamp: number
  status: 'ok' | 'degraded' | 'unavailable'
  metrics: AdminMetricsValues
  health: {
    database: AdminDependencyHealth
    redis: AdminDependencyHealth
  }
  prometheus: {
    available: boolean
    error?: string
  }
}

const PROMQL = {
  eventsAcceptedRate: 'sum(rate(nostream_events_accepted_total[1m]))',
  eventsRejectedRate: 'sum(rate(nostream_events_rejected_total[1m]))',
  eventsAcceptedTotal: 'sum(nostream_events_accepted_total)',
  eventsRejectedTotal: 'sum(nostream_events_rejected_total)',
  activeConnections: 'sum(nostream_websocket_connections)',
  cpuLoadPercent: 'avg(nostream_process_cpu_load_percent)',
  memoryUsedMb: 'sum(nostream_process_memory_used_mb)',
} as const

const toMetricValue = (value: number | undefined): number => {
  return value ?? 0
}

const emptyMetrics: AdminMetricsValues = {
  eventsPerSecond: 0,
  eventsRejectedPerSecond: 0,
  eventsAcceptedTotal: 0,
  eventsRejectedTotal: 0,
  activeConnections: 0,
  cpuLoadPercent: 0,
  memoryUsedMb: 0,
}

export const createUnavailableAdminMetricsSnapshot = (error: string): AdminMetricsSnapshot => ({
  timestamp: Date.now(),
  status: 'unavailable',
  metrics: { ...emptyMetrics },
  health: {
    database: { ok: false },
    redis: { ok: false },
  },
  prometheus: {
    available: false,
    error,
  },
})

let cachedSnapshot: AdminMetricsSnapshot | undefined
let cachedAt = 0
let snapshotInFlight: Promise<AdminMetricsSnapshot> | undefined

export const resetAdminMetricsSnapshotCache = (): void => {
  cachedSnapshot = undefined
  cachedAt = 0
  snapshotInFlight = undefined
}

const collectAdminMetricsSnapshotUncached = async (): Promise<AdminMetricsSnapshot> => {
  const [
    health,
    eventsAcceptedRate,
    eventsRejectedRate,
    eventsAcceptedTotal,
    eventsRejectedTotal,
    activeConnections,
    cpuLoadPercent,
    memoryUsedMb,
  ] = await Promise.all([
    collectAdminHealthSnapshot(),
    queryPrometheusInstant(PROMQL.eventsAcceptedRate),
    queryPrometheusInstant(PROMQL.eventsRejectedRate),
    queryPrometheusInstant(PROMQL.eventsAcceptedTotal),
    queryPrometheusInstant(PROMQL.eventsRejectedTotal),
    queryPrometheusInstant(PROMQL.activeConnections),
    queryPrometheusInstant(PROMQL.cpuLoadPercent),
    queryPrometheusInstant(PROMQL.memoryUsedMb),
  ])

  const prometheusAvailable =
    eventsAcceptedRate !== undefined ||
    eventsRejectedRate !== undefined ||
    eventsAcceptedTotal !== undefined ||
    eventsRejectedTotal !== undefined ||
    activeConnections !== undefined ||
    cpuLoadPercent !== undefined ||
    memoryUsedMb !== undefined

  const metricsHealthy = health.database.ok && health.redis.ok
  let status: AdminMetricsSnapshot['status'] = 'ok'

  if (!prometheusAvailable) {
    status = 'unavailable'
  } else if (!metricsHealthy) {
    status = 'degraded'
  }

  return {
    timestamp: Date.now(),
    status,
    metrics: {
      eventsPerSecond: toMetricValue(eventsAcceptedRate),
      eventsRejectedPerSecond: toMetricValue(eventsRejectedRate),
      eventsAcceptedTotal: toMetricValue(eventsAcceptedTotal),
      eventsRejectedTotal: toMetricValue(eventsRejectedTotal),
      activeConnections: toMetricValue(activeConnections),
      cpuLoadPercent: toMetricValue(cpuLoadPercent),
      memoryUsedMb: toMetricValue(memoryUsedMb),
    },
    health: {
      database: health.database,
      redis: health.redis,
    },
    prometheus: {
      available: prometheusAvailable,
      ...(prometheusAvailable ? {} : { error: 'Prometheus query returned no data' }),
    },
  }
}

export const collectAdminMetricsSnapshot = async (): Promise<AdminMetricsSnapshot> => {
  const cacheTtlMs = getAdminMetricsSseIntervalMs()
  const now = Date.now()

  if (cachedSnapshot && now - cachedAt < cacheTtlMs) {
    return cachedSnapshot
  }

  if (snapshotInFlight) {
    return snapshotInFlight
  }

  snapshotInFlight = collectAdminMetricsSnapshotUncached()
    .then((snapshot) => {
      cachedSnapshot = snapshot
      cachedAt = Date.now()
      return snapshot
    })
    .finally(() => {
      snapshotInFlight = undefined
    })

  return snapshotInFlight
}

export const getAdminMetricsSseIntervalMs = (): number => {
  const intervalCandidate = Number(process.env.ADMIN_METRICS_SSE_INTERVAL_MS || 5000)

  if (!Number.isFinite(intervalCandidate) || intervalCandidate < 1000) {
    return 5000
  }

  return intervalCandidate
}
