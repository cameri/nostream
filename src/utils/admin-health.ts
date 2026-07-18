import { getCacheClient } from '../cache/client'
import { getMasterDbClient } from '../database/client'
import { createLogger } from '../factories/logger-factory'
import { delayMs } from './misc'

const logger = createLogger('admin-health')

const DEFAULT_ADMIN_DEPENDENCY_PING_TIMEOUT_MS = 3000
const MIN_ADMIN_DEPENDENCY_PING_TIMEOUT_MS = 100

export interface AdminDependencyHealth {
  ok: boolean
}

export interface AdminHealthSnapshot {
  status: 'ok' | 'degraded'
  uptimeSeconds: number
  worker: {
    type: string
    index?: string
  }
  database: AdminDependencyHealth
  redis: AdminDependencyHealth
}

export const getAdminDependencyPingTimeoutMs = (): number => {
  const configuredValue = process.env.ADMIN_DEPENDENCY_PING_TIMEOUT_MS
  if (configuredValue === undefined || configuredValue.trim() === '') {
    return DEFAULT_ADMIN_DEPENDENCY_PING_TIMEOUT_MS
  }

  const timeoutCandidate = Number(configuredValue)
  if (!Number.isFinite(timeoutCandidate) || timeoutCandidate < MIN_ADMIN_DEPENDENCY_PING_TIMEOUT_MS) {
    logger.warn(
      'invalid ADMIN_DEPENDENCY_PING_TIMEOUT_MS=%o, falling back to %d',
      configuredValue,
      DEFAULT_ADMIN_DEPENDENCY_PING_TIMEOUT_MS,
    )
    return DEFAULT_ADMIN_DEPENDENCY_PING_TIMEOUT_MS
  }

  return timeoutCandidate
}

export const collectAdminHealthSnapshot = async (): Promise<AdminHealthSnapshot> => {
  const [database, redis] = await Promise.all([pingDatabase(), pingRedis()])

  return {
    status: database.ok && redis.ok ? 'ok' : 'degraded',
    uptimeSeconds: Math.floor(process.uptime()),
    worker: {
      type: process.env.WORKER_TYPE ?? 'primary',
      ...(process.env.WORKER_INDEX ? { index: process.env.WORKER_INDEX } : {}),
    },
    database,
    redis,
  }
}

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
  return Promise.race([
    operation,
    delayMs(timeoutMs).then(() => {
      throw new Error(`dependency ping timed out after ${timeoutMs}ms`)
    }),
  ])
}

const pingDatabase = async (): Promise<AdminDependencyHealth> => {
  const timeoutMs = getAdminDependencyPingTimeoutMs()

  try {
    await withTimeout(getMasterDbClient().raw('SELECT 1'), timeoutMs)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

const pingRedis = async (): Promise<AdminDependencyHealth> => {
  const timeoutMs = getAdminDependencyPingTimeoutMs()

  try {
    const client = getCacheClient()
    if (!client.isOpen) {
      await withTimeout(client.connect(), timeoutMs)
    }
    const pong = await withTimeout(client.ping(), timeoutMs)
    return { ok: pong === 'PONG' }
  } catch {
    return { ok: false }
  }
}
