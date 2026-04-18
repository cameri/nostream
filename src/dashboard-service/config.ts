export interface DashboardServiceConfig {
  host: string
  port: number
  wsPath: string
  pollIntervalMs: number
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

export const getDashboardServiceConfig = (): DashboardServiceConfig => {
  return {
    host: process.env.DASHBOARD_SERVICE_HOST ?? '127.0.0.1',
    port: parseInteger(process.env.DASHBOARD_SERVICE_PORT, 8011),
    wsPath: process.env.DASHBOARD_WS_PATH ?? '/api/v1/kpis/stream',
    pollIntervalMs: parseInteger(process.env.DASHBOARD_POLL_INTERVAL_MS, 5000),
  }
}
