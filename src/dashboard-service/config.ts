import { parseArgs } from 'util'

export interface DashboardServiceConfig {
  host: string
  port: number
  wsPath: string
  pollIntervalMs: number
  useDummyData: boolean
}

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

export const getDashboardServiceConfig = (): DashboardServiceConfig => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'h' },
    },
    strict: false,
  })

  return {
    host: (values.host as string) ?? process.env.DASHBOARD_SERVICE_HOST ?? '127.0.0.1',
    port: parseInteger(values.port as string, parseInteger(process.env.DASHBOARD_SERVICE_PORT, 8011)),
    wsPath: process.env.DASHBOARD_WS_PATH ?? '/api/v1/kpis/stream',
    pollIntervalMs: parseInteger(process.env.DASHBOARD_POLL_INTERVAL_MS, 5000),
    useDummyData: parseBoolean(process.env.DASHBOARD_USE_DUMMY_DATA, false),
  }
}
