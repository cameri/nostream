import { NextFunction, Request, Response } from 'express'

import { AdminDependencyHealth, collectAdminHealthSnapshot } from '../../utils/admin-health'

// Public readiness probe for load balancers (e.g. HAProxy blue/green). Unlike /healthz
// (liveness), /readyz returns non-200 when Postgres or Redis is unavailable.
export interface ReadyzSnapshot {
  status: 'ok' | 'unavailable'
  database: AdminDependencyHealth
  redis: AdminDependencyHealth
}

export const buildReadyzSnapshot = (database: AdminDependencyHealth, redis: AdminDependencyHealth): ReadyzSnapshot => {
  const ready = database.ok && redis.ok

  return {
    status: ready ? 'ok' : 'unavailable',
    database,
    redis,
  }
}

export const getReadyzRequestHandler = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const health = await collectAdminHealthSnapshot()
    const snapshot = buildReadyzSnapshot(health.database, health.redis)
    const statusCode = snapshot.status === 'ok' ? 200 : 503

    res.status(statusCode).setHeader('content-type', 'application/json; charset=utf-8').send(snapshot)
  } catch {
    res
      .status(503)
      .setHeader('content-type', 'application/json; charset=utf-8')
      .send({
        status: 'unavailable',
        database: { ok: false },
        redis: { ok: false },
      } satisfies ReadyzSnapshot)
  }

  next()
}
