import { NextFunction, Request, Response } from 'express'

import { AdminDependencyHealth, collectAdminHealthSnapshot } from '../../utils/admin-health'
import { isDraining } from '../../utils/shutdown-state'

// Public readiness probe for load balancers (e.g. HAProxy blue/green). Unlike /healthz
// (liveness), /readyz returns non-200 when Postgres or Redis is unavailable.
const READY_SNAPSHOT_CACHE_TTL_MS = 1000

export interface ReadyzSnapshot {
  status: 'ok' | 'unavailable'
  database: AdminDependencyHealth
  redis: AdminDependencyHealth
}

interface CachedReadyzSnapshot {
  snapshot: ReadyzSnapshot
  expiresAt: number
}

let cachedReadyzSnapshot: CachedReadyzSnapshot | undefined
let inFlightReadyzSnapshot: Promise<ReadyzSnapshot> | undefined

export const resetReadyzSnapshotCache = (): void => {
  cachedReadyzSnapshot = undefined
  inFlightReadyzSnapshot = undefined
}

export const buildReadyzSnapshot = (database: AdminDependencyHealth, redis: AdminDependencyHealth): ReadyzSnapshot => {
  const ready = database.ok && redis.ok

  return {
    status: ready ? 'ok' : 'unavailable',
    database,
    redis,
  }
}

const collectReadyzSnapshot = async (): Promise<ReadyzSnapshot> => {
  const now = Date.now()
  if (cachedReadyzSnapshot && cachedReadyzSnapshot.expiresAt > now) {
    return cachedReadyzSnapshot.snapshot
  }

  if (inFlightReadyzSnapshot) {
    return inFlightReadyzSnapshot
  }

  inFlightReadyzSnapshot = (async () => {
    const health = await collectAdminHealthSnapshot()
    const snapshot = buildReadyzSnapshot(health.database, health.redis)
    cachedReadyzSnapshot = {
      snapshot,
      expiresAt: Date.now() + READY_SNAPSHOT_CACHE_TTL_MS,
    }

    return snapshot
  })()

  try {
    return await inFlightReadyzSnapshot
  } finally {
    inFlightReadyzSnapshot = undefined
  }
}

const sendReadyzResponse = (res: Response, statusCode: number, snapshot: ReadyzSnapshot): void => {
  res
    .status(statusCode)
    .setHeader('content-type', 'application/json; charset=utf-8')
    .setHeader('cache-control', 'no-store')
    .send(snapshot)
}

export const getReadyzRequestHandler = async (_req: Request, res: Response, next: NextFunction) => {
  if (isDraining()) {
    sendReadyzResponse(res, 503, {
      status: 'unavailable',
      database: { ok: false },
      redis: { ok: false },
    })
    next()
    return
  }

  try {
    const snapshot = await collectReadyzSnapshot()
    const statusCode = snapshot.status === 'ok' ? 200 : 503
    sendReadyzResponse(res, statusCode, snapshot)
  } catch {
    sendReadyzResponse(res, 503, {
      status: 'unavailable',
      database: { ok: false },
      redis: { ok: false },
    })
  }

  next()
}
