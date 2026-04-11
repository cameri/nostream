export interface DashboardServiceConfig {
  host: string
  port: number
  wsPath: string
  pollIntervalMs: number
  useDummyData: boolean
  collectorMode: DashboardCollectorMode
}

export type DashboardCollectorMode = 'full' | 'incremental' | 'stateful-incremental'

const parseBoolean = (value: string | undefined, fallback = false): boolean => {
  if (typeof value === 'undefined') {
    return fallback
  }

  return value === '1' || value.toLowerCase() === 'true'
}

const parseInteger = (value: string | undefined, fallback: number): number => {
  if (typeof value === 'undefined' || value === '') {
    return fallback
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback
  }

  return parsed
}

const parseCollectorMode = (
  value: string | undefined,
  fallback: DashboardCollectorMode = 'full',
): DashboardCollectorMode => {
  if (typeof value === 'undefined') {
    return fallback
  }

  const normalized = value.toLowerCase()
  if (normalized === 'full' || normalized === 'incremental' || normalized === 'stateful-incremental') {
    return normalized
  }
  
  return fallback
}

export const getDashboardServiceConfig = (): DashboardServiceConfig => {
  return {
    host: process.env.DASHBOARD_SERVICE_HOST ?? '127.0.0.1',
    port: parseInteger(process.env.DASHBOARD_SERVICE_PORT, 8011),
    wsPath: process.env.DASHBOARD_WS_PATH ?? '/api/v1/kpis/stream',
    pollIntervalMs: parseInteger(process.env.DASHBOARD_POLL_INTERVAL_MS, 5000),
    useDummyData: parseBoolean(process.env.DASHBOARD_USE_DUMMY_DATA, false),
    collectorMode: parseCollectorMode(process.env.DASHBOARD_COLLECTOR_MODE, 'full'),
  }
}
