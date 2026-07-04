import { getCacheClient } from '../cache/client'
import { getMasterDbClient } from '../database/client'

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

export const collectAdminHealthSnapshot = async (): Promise<AdminHealthSnapshot> => {
  const database = await pingDatabase()
  const redis = await pingRedis()

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

const pingDatabase = async (): Promise<AdminDependencyHealth> => {
  try {
    await getMasterDbClient().raw('SELECT 1')
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

const pingRedis = async (): Promise<AdminDependencyHealth> => {
  try {
    const client = getCacheClient()
    if (!client.isOpen) {
      await client.connect()
    }
    const pong = await client.ping()
    return { ok: pong === 'PONG' }
  } catch {
    return { ok: false }
  }
}
